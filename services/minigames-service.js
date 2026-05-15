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

  emitOverlay({
    kind: 'dice-roll',
    dice, mode, total, count,
    durationMs: DICE_ANIMATION_MS,
    by: byNickname || (byEmail ? byEmail.split('@')[0] : 'someone'),
  });

  logger.info(`dice roll: ${count}d6 [${dice.join(',')}] = ${total} (${mode}) by ${byNickname || byEmail || 'unknown'}`);

  return actionEngine.fireAction({
    inline: {
      name: `🎲 ${count}d6 [${dice.join(',')}] = ${total} → ${modeLabel}`,
      steps,
    },
    byEmail, byNickname,
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

// Two-phase prize-wheel flow:
//   1. requestPrizeWheel — pre-computes the chain (incl. randomization per
//      spin if the wheel has randomize=true), emits an `overlay` event with
//      ONLY the first spin's section order (so clients can render the wheel
//      stationary), stores the rest server-side keyed by a spin token, and
//      schedules an auto-confirm in case the trigger never presses Spin.
//   2. confirmPrizeSpin — fired when the trigger clicks the Spin button.
//      Emits a second overlay event with the full chain (now safe to send,
//      since the user committed to spinning) and fires the inline pump
//      action with a chainLength * PRIZE_WHEEL_ANIMATION_MS off-step prefix
//      so the gauge stays locked through the animation.
const PENDING_PRIZE_SPINS = new Map();      // spinToken -> pending state
const PRIZE_WHEEL_AUTO_SPIN_MS = 30000;     // safety cap for unconfirmed pendings

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
  // Reject if this trigger already has a pending spin or anything else is
  // running on the gauge — keeps the UX from ending up in a weird race.
  for (const p of PENDING_PRIZE_SPINS.values()) {
    if (p.byEmail === byEmail) throw new Error('you already have a pending wheel spin — press Spin or wait');
  }

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
  const spinToken = randomUUID();
  const pending = { wheel, chain, finalSection, byEmail, byNickname: by, timeoutHandle: null };
  pending.timeoutHandle = setTimeout(() => _confirmInternal(spinToken, 'timeout'), PRIZE_WHEEL_AUTO_SPIN_MS);
  PENDING_PRIZE_SPINS.set(spinToken, pending);

  emitOverlay({
    kind: 'prize-wheel',
    wheel: { name: wheel.name },
    initialSections: chain[0].sections,  // stationary display only — chain not leaked
    durationMsPerSpin: PRIZE_WHEEL_ANIMATION_MS,
    by,
    triggeredBy: byEmail,
    spinToken,
  });

  logger.info(`prize wheel requested: "${wheel.name}" by ${by} — token ${spinToken.slice(0,8)}, chain length ${chain.length}`);
  return { ok: true, spinToken };
}

function confirmPrizeSpin({ spinToken, byEmail }) {
  const pending = PENDING_PRIZE_SPINS.get(spinToken);
  if (!pending) throw new Error('no pending spin for that token');
  if (byEmail && byEmail !== pending.byEmail) throw new Error('only the spinner can press Spin');
  return _confirmInternal(spinToken, 'user');
}

function _confirmInternal(spinToken, source) {
  const pending = PENDING_PRIZE_SPINS.get(spinToken);
  if (!pending) return;
  PENDING_PRIZE_SPINS.delete(spinToken);
  if (pending.timeoutHandle) { clearTimeout(pending.timeoutHandle); pending.timeoutHandle = null; }

  emitOverlay({
    kind: 'prize-wheel-spin',
    spinToken,
    chain: pending.chain,
    durationMsPerSpin: PRIZE_WHEEL_ANIMATION_MS,
    finalLabel: pending.finalSection.label,
    finalType: pending.finalSection.type,
  });

  if (pending.chain.length > 1) {
    chat.system(`${pending.byNickname} spun ${pending.wheel.name} — ${pending.chain.length} spins (${pending.chain.length - 1} re-roll${pending.chain.length - 1 === 1 ? '' : 's'}) → ${pending.finalSection.label}`);
  }

  const animationLockMs = pending.chain.length * PRIZE_WHEEL_ANIMATION_MS;
  const pumpSteps = (pending.finalSection.type === 'action' && Array.isArray(pending.finalSection.steps))
    ? pending.finalSection.steps : [];
  const steps = [{ type: 'off', durationMs: animationLockMs }, ...pumpSteps];

  // Fire the action AFTER the spin is confirmed so the gauge isn't locked
  // while the wheel sits idle. If something else got fired between request
  // and confirm (race), action-engine will throw — log and move on.
  Promise.resolve(actionEngine.fireAction({
    inline: { name: `🎡 ${pending.wheel.name} → ${pending.finalSection.label}`, steps },
    byEmail: pending.byEmail, byNickname: pending.byNickname,
  })).catch(e => logger.warn(`confirm spin fireAction failed (${source}): ${e.message}`));
}

module.exports = {
  list, get, runDiceRoll,
  requestPrizeWheel, confirmPrizeSpin,
  DICE_ANIMATION_MS, PRIZE_WHEEL_ANIMATION_MS, PRIZE_WHEEL_MAX_CHAIN,
};
