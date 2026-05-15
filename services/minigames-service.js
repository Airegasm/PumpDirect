const { randomUUID } = require('crypto');
const { emitOverlay } = require('./event-bus');
const actionEngine = require('./action-engine');
const templates = require('./templates-service');
const chat = require('./chat-service');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Minigames');

// How long the dice overlay is mounted before the pump action kicks in.
// Lottie dice-number-N.json files are 2s at 30fps; we hold for an extra ~500ms
// after the animation finishes so the result is visible before the dice fade.
const DICE_ANIMATION_MS = 2500;

// Registry — minigames are static metadata for now; their runtime lives in
// dedicated functions like runDiceRoll() below. Buttons in the milestone-pane
// reference these by id, and the templates editor lets the owner attach them
// to milestones / always-available pools.
const MINIGAMES = Object.freeze([
  Object.freeze({
    id: 'dice-roll',
    name: 'Dice Roll',
    kind: 'dice-roll',
    color: '#7b3fd6',
    description: 'Roll 1–6 d6 dice; the total pips drive the pump (continuous or 1s on/off cycle).',
  }),
  Object.freeze({
    id: 'prize-wheel',
    name: 'Prize Wheel',
    kind: 'prize-wheel',
    color: '#7b3fd6',
    description: 'Spin a custom wheel. Each wedge fires its configured pump action; "Spin again" re-spins; "No prize" lands silently.',
    // When attached to a milestone or always-available, the editor configures
    // minigameConfig['prize-wheel'].wheelIds — the wheels available to that button.
    configurable: true,
  }),
]);

const PRIZE_WHEEL_ANIMATION_MS = 4500;
const PRIZE_WHEEL_MAX_CHAIN = 8;

function list() { return MINIGAMES.slice(); }
function get(id) { return MINIGAMES.find(m => m.id === id) || null; }

function rollDice(count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(1 + Math.floor(Math.random() * 6));
  return out;
}

// Fires a dice-roll: computes the result, broadcasts the overlay payload so
// every client renders the same dice landing on the same faces, and schedules
// the resulting pump as an inline action whose first step is a 3s "off" hold
// matching the animation duration — so the action lock kicks in immediately
// (blocking other actions) while the dice are still rolling.
function runDiceRoll({ count, mode, byEmail, byNickname }) {
  count = Math.max(1, Math.min(6, parseInt(count, 10) || 1));
  if (mode !== 'continuous' && mode !== 'cycle') mode = 'continuous';
  const dice = rollDice(count);
  const total = dice.reduce((a, b) => a + b, 0);
  const modeLabel = mode === 'cycle' ? `${total} × 1s on/off` : `${total}s continuous`;

  let pumpSteps;
  if (mode === 'cycle') {
    pumpSteps = [{
      type: 'repeat', times: total, steps: [
        { type: 'on',  durationMs: 1000 },
        { type: 'off', durationMs: 1000 },
      ],
    }];
  } else {
    pumpSteps = [{ type: 'on', durationMs: total * 1000 }];
  }
  // Prepended off-step holds the action lock during the dice animation so
  // visitors / owner can't double-fire. The overlay covers #session-stage so
  // the "off (3s)" countdown isn't visible underneath.
  const steps = [{ type: 'off', durationMs: DICE_ANIMATION_MS }, ...pumpSteps];

  const byName = byNickname || (byEmail ? byEmail.split('@')[0] : 'someone');
  emitOverlay({
    kind: 'dice-roll',
    dice, mode, total, count,
    durationMs: DICE_ANIMATION_MS,
    by: byName,
  });
  // Fire the flash AFTER the dice animation settles so the result is shown
  // alongside the landed values rather than before they're known on-screen.
  const diceLabel = `${byName} rolled ${dice.join(', ')} → ${mode === 'cycle' ? `${total} × 1s on/off` : `${total}s continuous`}`;
  setTimeout(() => { emitOverlay({ kind: 'action-flash', text: diceLabel }); }, DICE_ANIMATION_MS);

  logger.info(`dice roll: ${count}d6 [${dice.join(',')}] = ${total} (${mode}) by ${byNickname || byEmail || 'unknown'}`);

  return actionEngine.fireAction({
    inline: {
      name: `🎲 ${count}d6 [${dice.join(',')}] = ${total} → ${modeLabel}`,
      steps,
    },
    byEmail, byNickname, silentFlash: true,
  });
}

// Build one spin step. Returns { sections, targetIndex, picked } where sections
// is the (possibly shuffled) ordering shown on the wheel for this spin and
// picked is the wheel section the pointer landed on.
function _spinOnce(wheel) {
  const ordered = wheel.randomize ? _shuffle(wheel.sections.slice()) : wheel.sections.slice();
  const targetIndex = Math.floor(Math.random() * ordered.length);
  return { sections: ordered, targetIndex, picked: ordered[targetIndex] };
}
function _shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Single-shot prize-wheel: pre-computes the chain (incl. randomization per
// spin if the wheel has randomize=true), emits ONE overlay with the wheel +
// full chain, and immediately fires the inline pump action behind a
// chainLength × PRIZE_WHEEL_ANIMATION_MS off-step so the gauge stays locked
// through the animation. The wheel auto-spins client-side — no Spin button.
function requestPrizeWheel({ wheelId, wheelIds, allowedWheelIds, byEmail, byNickname }) {
  // Caller can either pin a specific wheel (wheelId) or hand over a candidate
  // list (wheelIds); in the latter case the server picks one at random from
  // the candidates that also pass the allow-list. This is what milestone
  // buttons use so the spinner never gets to choose which wheel comes up.
  let chosenId = wheelId;
  if (!chosenId) {
    let candidates = Array.isArray(wheelIds) ? wheelIds.filter(Boolean) : [];
    if (Array.isArray(allowedWheelIds)) candidates = candidates.filter(id => allowedWheelIds.includes(id));
    if (!candidates.length) throw new Error('no wheels available to spin');
    chosenId = candidates[Math.floor(Math.random() * candidates.length)];
  }
  if (Array.isArray(allowedWheelIds) && !allowedWheelIds.includes(chosenId)) {
    throw new Error('this wheel is not available at this button');
  }
  const wheel = templates.getWheel(chosenId);

  const chain = [];
  let finalSection = null;
  for (let i = 0; i < PRIZE_WHEEL_MAX_CHAIN; i++) {
    const step = _spinOnce(wheel);
    chain.push({
      sections: step.sections.map(s => ({ label: s.label, color: s.color, type: s.type })),
      targetIndex: step.targetIndex,
    });
    if (step.picked.type !== 'spin-again') {
      finalSection = step.picked;
      break;
    }
  }
  if (!finalSection) {
    finalSection = { label: 'No prize (chain limit)', color: '#7a8597', type: 'no-prize', steps: [] };
  }

  const by = byNickname || (byEmail ? byEmail.split('@')[0] : 'someone');

  emitOverlay({
    kind: 'prize-wheel',
    wheel: { name: wheel.name },
    chain,
    durationMsPerSpin: PRIZE_WHEEL_ANIMATION_MS,
    finalLabel: finalSection.label,
    finalType: finalSection.type,
    by,
    triggeredBy: byEmail,
  });
  // Fire the flash AFTER the full spin chain (incl. any re-rolls) settles
  // so the result label is meaningful when the pill appears.
  const animationLockMs = chain.length * PRIZE_WHEEL_ANIMATION_MS;
  const wheelLabel = `${by} spun the wheel → ${finalSection.label}`;
  setTimeout(() => { emitOverlay({ kind: 'action-flash', text: wheelLabel }); }, animationLockMs);

  logger.info(`prize wheel "${wheel.name}" by ${by} — ${chain.length} spin(s), result: ${finalSection.label} (${finalSection.type})`);
  const pumpSteps = (finalSection.type === 'action' && Array.isArray(finalSection.steps))
    ? finalSection.steps : [];
  const steps = [{ type: 'off', durationMs: animationLockMs }, ...pumpSteps];

  return actionEngine.fireAction({
    inline: { name: `🎡 ${wheel.name} → ${finalSection.label}`, steps },
    byEmail, byNickname, silentFlash: true,
  });
}

module.exports = {
  list, get, runDiceRoll,
  requestPrizeWheel,
  DICE_ANIMATION_MS, PRIZE_WHEEL_ANIMATION_MS, PRIZE_WHEEL_MAX_CHAIN,
};
