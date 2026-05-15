const express = require('express');
const { ownerLayout, escape } = require('../views/layout');

const router = express.Router();

const SECTIONS = [
  {
    id: 'getting-started',
    title: 'Getting started',
    summary: 'First-run setup, Cloudflare wizard, your first session.',
    body: `
      <ol>
        <li><strong>Install + start.</strong> Run <code>./start.sh</code> (Linux/macOS) or <code>start.bat</code> (Windows). Owner console at <code>http://localhost:3001</code>, public side at <code>http://localhost:3000</code>.</li>
        <li><strong>Accept the TOS.</strong> One-time per version. Every published release with a bumped <code>TOS_VERSION</code> forces a re-accept.</li>
        <li><strong>Cloudflare wizard (Network tab).</strong> Paste a CF API token, pick or create a tunnel, route DNS to your chosen hostname, enable Zero Trust, create the Access app + email-allow policy. The wizard writes everything via the API — no manual dashboard clicks needed.</li>
        <li><strong>Add your smart outlet (Devices tab).</strong> Scan for Kasa via LAN UDP broadcast, or add Tapo / Wyze / Govee / Tuya / Matter by credentials. Calibrate the pump plug (live timer or manual seconds-to-100%).</li>
        <li><strong>Invite guests (Users tab).</strong> Each entry pushes into the Cloudflare Access allow-policy. Guests get a one-time email PIN — no password to manage.</li>
        <li><strong>Build a session (Pump Templates → Launchpad).</strong> Stack milestones with announcements + action templates, attach a session profile on the Launchpad, hit <strong>Start Session</strong>.</li>
      </ol>
    `,
  },
  {
    id: 'launchpad',
    title: 'Launchpad',
    summary: 'The live session screen: capacity gauge, action buttons, session controls.',
    body: `
      <ul>
        <li><strong>Profile picker.</strong> Selects which session profile (milestones + minigames + triggers) is active. The last-used profile persists across reloads.</li>
        <li><strong>Capacity gauge.</strong> Shows current %. Click <em>Edit</em> to manually set it — the action engine resyncs so the next tick doesn't snap back.</li>
        <li><strong>Action grid.</strong> Buttons come from the current milestone's action templates. Each cell has a small <code>?</code> popover showing the step DSL (on/off/repeat) and any device targeting.</li>
        <li><strong>Session controls.</strong> Start Session, Standby (pauses + blacks out video), Stop, and E-STOP (instant cycle abort, no narration). A purple <strong>Custom End Session</strong> button appears below if you've configured one in Settings.</li>
        <li><strong>Cam tile.</strong> Click <strong>Start camera</strong> to publish video. Nothing else can start the cam — not adding participants, not toggling permission boxes, not reloading. Only Start camera, and only Stop camera / a <code>turn-off-host-cam</code> trigger sub-action / the cam mode flipping to <em>off</em> can stop it.</li>
        <li><strong>Settings (gear icon).</strong> Per-session-profile config: template profile, trigger template, custom end button, owner cam resolution, controller broadcast toggle.</li>
        <li><strong>Cam radio.</strong> <em>Off</em> = no video for anyone, <em>Live</em> = pump-room cam, <em>Standby</em> = blacked-out tile with frozen state.</li>
      </ul>
      <p class="muted">During a live session, navigating away from the Launchpad tab drops the cam mesh. Other tabs auto-open in new windows so the cam stays alive.</p>
    `,
  },
  {
    id: 'pump-templates',
    title: 'Pump Templates',
    summary: 'Milestones, action templates, the on/off/repeat step DSL.',
    body: `
      <h4>Milestones</h4>
      <p>A milestone is a capacity range (e.g. 0–25%) with a welcome message, an optional announcement, and a grid of action buttons. As capacity rises the active milestone advances — the visitor screen redraws to whatever the current milestone declares.</p>
      <h4>Action templates</h4>
      <p>Reusable named recipes. Each template is a list of <strong>steps</strong>:</p>
      <ul>
        <li><code>on N</code> — pump on for N seconds.</li>
        <li><code>off N</code> — pump off for N seconds.</li>
        <li><code>repeat N</code> — repeat the previous on/off pair N times.</li>
        <li><code>on infinite</code> — pump stays on with no off-step (non-blocking; the chain proceeds while the device stays on, same as the manual Pump On button).</li>
        <li><code>indefinite</code> — flag a repeat as unbounded; only stops on Stop / Standby / E-STOP / new action.</li>
      </ul>
      <p>Per-step device targeting picks which configured plug receives the on/off — leave blank for the default pump device, or set <code>all</code> to fan the step to every device.</p>
      <h4>Standard vs Trigger mode</h4>
      <p>Each action template has a mode radio.</p>
      <ul>
        <li><strong>Standard</strong> — runs the step list (the normal pump cycle).</li>
        <li><strong>Trigger</strong> — fires a Trigger Action or Trigger Action Group instead. Same lock behaviour (one action at a time), no calibration check, useful for "show overlay + play sound + end session" buttons that don't actually drive the pump.</li>
      </ul>
    `,
  },
  {
    id: 'devices',
    title: 'Devices',
    summary: 'Smart-outlet discovery, brand-by-brand notes, calibration.',
    body: `
      <h4>Supported brands</h4>
      <ul>
        <li><strong>Kasa (TP-Link)</strong> — LAN UDP broadcast scan. No cloud. Most reliable.</li>
        <li><strong>Tapo (TP-Link)</strong> — needs your TP-Link account email + password. Uses the Python helper.</li>
        <li><strong>Wyze</strong> — Wyze account + API key. Python helper.</li>
        <li><strong>Govee</strong> — Govee Developer API key. Pure Node.</li>
        <li><strong>Tuya</strong> — Tuya IoT Platform access credentials. Pure Node.</li>
        <li><strong>Matter</strong> — paired via setup-code / QR. Python helper.</li>
      </ul>
      <h4>Calibration</h4>
      <p>Two ways to calibrate seconds-to-100%:</p>
      <ul>
        <li><strong>Live timer.</strong> Start the pump from empty, click Stop when it hits target. The captured duration becomes the 0-to-100 reference.</li>
        <li><strong>Manual.</strong> Type the seconds value directly if you already know it.</li>
      </ul>
      <p>Calibration is per-device. Each device can also have a name override and an <em>is the pump</em> flag (the pump device is the default target for action steps that don't specify one).</p>
    `,
  },
  {
    id: 'triggers',
    title: 'Triggers',
    summary: 'Trigger Actions, Trigger Action Groups, Trigger Templates, sub-action kinds.',
    body: `
      <p>Three layers, deepest first:</p>
      <ol>
        <li><strong>Trigger Action</strong> — a named, ordered list of <em>sub-actions</em>. Sub-actions run sequentially when the trigger fires.</li>
        <li><strong>Trigger Action Group</strong> — a named, ordered list of Trigger Actions. The group fires them back-to-back.</li>
        <li><strong>Trigger Template</strong> — a list of <code>CAPACITY_REACHED @ N%</code> rows, each pointing at a Trigger Action or Group. Attach a template to a session profile; the matching row fires <em>once per session</em> as capacity climbs past N%.</li>
      </ol>
      <h4>Sub-action kinds</h4>
      <ul>
        <li><strong>text-overlay</strong> — text card anchored over the host cam. 5 anchors: top-left / top-right / bottom-left / bottom-right / center. ADD adds a card; CLEAR removes the card at that anchor (or <code>all</code> to clear every anchor).</li>
        <li><strong>lottie-overlay</strong> — Lottie animation positioned + sized over the host cam tile. Drag-to-position editor, Center snap button, width slider. Optional freeze-last-frame so the final frame persists. Upload <code>.json</code> Lottie files inline via the file row.</li>
        <li><strong>video-overlay</strong> — WebM (or MP4) video positioned + sized over the host cam tile. Alpha-channel WebM composites transparently (Chrome / Firefox / Edge); Safari falls back to opaque. Same drag-to-position editor as lottie. Options: <em>Loop</em> (plays forever until cleared), <em>Freeze last frame</em> (holds the last frame after playback), <em>Muted</em> (forces no audio — useful when you've paired the clip with a separate <code>play-sound</code> sub-action). Use the <code>mp4towebm</code> utility in <code>~/Projects/mp4towebm</code> to chroma-key talking-head footage into alpha WebM.</li>
        <li><strong>play-sound</strong> — plays an audio file to all participants. Optional blocking hold (chain waits until playback finishes). Upload audio files inline.</li>
        <li><strong>device-control</strong> — direct on / on-cycle / off on any device (or <code>all</code>). <em>on infinite</em> is non-blocking so the chain proceeds while the device stays on. <em>off</em> as the <strong>first</strong> sub-action of a trigger preempts any running pump action (timed, cycled, or manual on) so the chain runs immediately instead of queueing; <em>off</em> later in the chain just queues normally — it's part of the planned sequence.</li>
        <li><strong>wait</strong> — pauses the chain for N seconds.</li>
        <li><strong>turn-off-host-cam</strong> — kills the host cam stream cleanly (visitors get a track-end, not a frozen frame).</li>
        <li><strong>end-session</strong> — ends the session. Instant or delayed; delayed shows a full-stage "Session ending in N" countdown that layers <em>above</em> any frozen lottie at the overlay stage.</li>
      </ul>
      <h4>Editor UX</h4>
      <ul>
        <li><strong>Collapsible rows.</strong> Existing sub-actions open collapsed with a one-line summary; new rows open expanded.</li>
        <li><strong>Drag to reorder.</strong> Grab the handle on the left of any row.</li>
        <li><strong>Copy button.</strong> Deep-clones a row in place.</li>
      </ul>
    `,
  },
  {
    id: 'mini-games',
    title: 'Mini games',
    summary: 'Dice Roll and Prize Wheel — milestone-attached random outcomes.',
    body: `
      <h4>Dice Roll</h4>
      <p>Lottie-animated dice. Each face maps to a Trigger Action / Group. Roll → animation plays → mapped chain fires.</p>
      <h4>Prize Wheel</h4>
      <ul>
        <li><strong>Sections.</strong> 1–10 per wheel, each typed as <code>action</code> (run pump steps), <code>spin-again</code>, or <code>no-prize</code>. Per-section pump steps for the action type.</li>
        <li><strong>Auto-spin.</strong> No Spin button — the wheel mounts and spins immediately. Server emits a single overlay carrying the full result chain.</li>
        <li><strong>Multi-wheel pick.</strong> If a milestone lists multiple wheels, the <em>server</em> randomly picks one for that roll. The visitor doesn't get to game it.</li>
        <li><strong>Vertical labels.</strong> Section labels render radially so longer names fit.</li>
      </ul>
      <p>Attach mini-games to milestones from the Pump Templates editor.</p>
    `,
  },
  {
    id: 'session-profile',
    title: 'Session profiles + Custom End Button',
    summary: 'Per-profile settings: template, trigger template, custom end, owner cam resolution.',
    body: `
      <p>A session profile bundles everything the session needs: template profile (milestones), trigger template, mini-games, owner cam mode/resolution, controller broadcast toggle, and the optional Custom End Button.</p>
      <h4>Session Intro Button</h4>
      <ol>
        <li>Open <strong>Launchpad → Settings</strong>.</li>
        <li>Tick <em>Enable Session Intro Button</em>.</li>
        <li>Type the button text and pick a Trigger Action or Group.</li>
      </ol>
      <p>When the session starts, the Pump Action Control Panel renders <strong>disabled</strong> for everyone — owner and any visitor controller. A green Intro button appears above the Custom End button (or where the Custom End button would be). Pressing it fires the configured trigger; when the chain finishes, the action panel unlocks. Useful for forced "watch the rules / consent video / countdown" presentations before the session is interactable. If you also want the intro itself to be uninterruptible, build it as a single trigger action with a leading <code>device-control: off</code> sub-action — the gate prevents anyone from firing pump actions, and the leading off is a no-op until something tries to run.</p>
      <h4>Custom Session End Button</h4>
      <ol>
        <li>Open <strong>Launchpad → Settings</strong>.</li>
        <li>Tick <em>Enable Custom Session End Button</em>.</li>
        <li>Type the button text.</li>
        <li>Pick a target: Trigger Action or Trigger Action Group.</li>
      </ol>
      <p>A purple button appears below the Stop / E-STOP / Standby cluster. Firing it preempts any running pump action and runs the configured chain. Use it to wrap a session with a finale: text overlay + lottie + countdown end.</p>
    `,
  },
  {
    id: 'dual-target',
    title: 'Dual-Target session mode',
    summary: 'Two people, two pumps, one shared button library. Federated: target runs PumpDirect locally.',
    body: `
      <p>Dual-Target lets you operate a second person's smart-plug pump alongside your own, both on cam, with one shared library of action buttons and an A/B toggle that picks which pump the next press fires on. Each side runs PumpDirect locally; their browser bridges the host's session to their local instance over a token-authenticated localhost-only API.</p>
      <h4>Setup</h4>
      <ol>
        <li><strong>Both parties install PumpDirect</strong> and calibrate their primary pump (Devices tab → calibration).</li>
        <li>On the host, open <strong>Launchpad → Settings</strong> and switch the active profile's <em>Session mode</em> to <strong>Dual Target</strong>. Optionally tick <em>Allow visitor controllers in dual mode</em> if you want non-target visitors with the A flag to also fire actions.</li>
        <li>Invite the target the normal way (Users tab). They visit the host's Cloudflare Access URL like any other guest.</li>
        <li>On the host, tick <strong>T</strong> next to the target's name in the participant list. Their browser does a handshake with their own localhost PumpDirect, validates calibration, and reports back. If the handshake fails (PumpDirect not running, device not calibrated, version mismatch), they get demoted to standard guest automatically.</li>
      </ol>
      <h4>Starting the session</h4>
      <p>Dual sessions require <strong>mutual consent</strong>. After Start Session, a purple banner shows until both the host and the target tap <em>Confirm Start</em>. The Pump Action Control Panel stays locked until both parties confirm AND a target is paired. The banner auto-updates to reflect what it's waiting for (target to pair, host to confirm, target to confirm, both to confirm).</p>
      <h4>Operating during a session</h4>
      <ul>
        <li><strong>A/B toggle</strong> above the action grid picks which pump the next button press fires on — host's or target's. Per-tab state (sessionStorage), so different viewers can have it set differently.</li>
        <li>All pump buttons (action templates, Pump On / Off / Timed / Cycle) respect the toggle.</li>
        <li><strong>Two cam tiles + two gauges</strong> stacked vertically (one pair per operator). Each gauge floats next to its operator's cam; on mobile they shrink to corner chips.</li>
        <li>Capacity, pumpOn state, and current-action are relayed from the target's local PumpDirect via an SSE stream → forwarded to the host so everyone sees both gauges update live.</li>
        <li><strong>Target safety button</strong>: a sticky red "⏹ Stop my pump" button overlays the target's own cam tile in their visitor view. Hits localhost directly, bypassing the host — always works even if the host is unreachable.</li>
      </ul>
      <h4>Failure handling</h4>
      <ul>
        <li>Target's PumpDirect crashes mid-session → their browser detects it (8s status poll) and self-demotes. T flag clears.</li>
        <li>Target's tab closes → after the rejoin grace window expires, the T slot frees automatically. <code>navigator.sendBeacon</code> also releases the local pairing for clean teardown.</li>
        <li>Host reloads mid-session → state re-emit shows their T still paired, no re-handshake needed.</li>
        <li>Major version mismatch between host and target's PumpDirect → handshake rejected with a clear log message.</li>
      </ul>
      <h4>Privacy posture in dual mode</h4>
      <p>Same as single mode: no third party touches the media (DTLS-SRTP peer-to-peer over Cloudflare Tunnel for video, AES-256-GCM E2EE for chat). The host never receives the target's plug credentials — the satellite token is generated by the target's local PumpDirect and only authorizes the specific session it was issued for. Action steps cross the wire as plain JSON, but they're literal step lists (on/off/repeat durations) — no addresses, no credentials.</p>
    `,
  },
  {
    id: 'permissions',
    title: 'Participant permissions',
    summary: 'Connect / Action / Video / Broadcast — what each tickbox actually gates.',
    body: `
      <ul>
        <li><strong>Connect</strong> — can the participant join at all. Off = blocked at the gate, even if they cleared Cloudflare Access.</li>
        <li><strong>Action (canControl)</strong> — can the participant press action buttons that affect the pump. Off = view-only voyeur.</li>
        <li><strong>Video (canBroadcast)</strong> — can the participant publish a camera. Off = receive-only.</li>
        <li><strong>Global "Allow controller broadcast"</strong> (session profile) — master switch above the participant flags. If off, <em>no</em> visitor can publish even if their own Video flag is ticked.</li>
      </ul>
      <p>Server-side enforcement is strict: a publishing visitor whose permission gets revoked mid-stream gets a <code>force-unbroadcast</code> push that tears down their local stream and tells peers to drop the tile. Toggling these flags can't be bypassed by stale tabs or clever WebRTC offers — the server drops any offer that doesn't satisfy global AND Connect AND Action AND Video.</p>
    `,
  },
  {
    id: 'control-handoff',
    title: 'Control hand-off',
    summary: 'Pass controller seat from one participant to another, live.',
    body: `
      <p>The active controller can tap a voyeur's name in the participant list to hand off control. A confirm popup appears:</p>
      <blockquote class="muted" style="border-left:3px solid var(--accent);padding:6px 12px;background:var(--bg-3);border-radius:0 8px 8px 0">Pass control to <em>name</em>?</blockquote>
      <p>On accept:</p>
      <ul>
        <li>The tapper becomes a voyeur (Action off).</li>
        <li>The target becomes the controller (Action on, Video off by default — they can re-enable if their global flag allows it).</li>
        <li>The change persists to the session profile and the live session, broadcasts state, and narrates in chat.</li>
      </ul>
    `,
  },
  {
    id: 'security',
    title: 'Security model',
    summary: 'How PumpDirect protects sessions: CF Access, E2EE chat, DTLS-SRTP, TOS, gitignored personal data.',
    body: `
      <ul>
        <li><strong>Access gate.</strong> The public URL is fronted by Cloudflare Access — a guest must sign in via the operator's chosen identity provider (default: one-time email PIN). Outside the allow-policy, the URL is unusable.</li>
        <li><strong>End-to-end chat.</strong> Chat messages and snapshot images are AES-256-GCM under a per-session symmetric key. Cloudflare's TLS-terminating edge only ever sees ciphertext. See <code>views/chat-crypto.js</code>.</li>
        <li><strong>Media transport.</strong> WebRTC mandates DTLS-SRTP for video / audio / data channels. Peer-to-peer where the network allows; falls back to a relay only for symmetric NATs.</li>
        <li><strong>Strict permission enforcement.</strong> Broadcast permission is checked server-side on every WS message (webrtc-offer, broadcast-state). Revoke triggers an immediate force-unbroadcast.</li>
        <li><strong>Versioned TOS.</strong> Every release with a bumped <code>TOS_VERSION</code> forces every owner to re-accept on next launch. Visitors get a per-session age-gate (keyed to <code>state.startedAt</code> so reusing the browser tab doesn't bypass it).</li>
        <li><strong>Personal data is local.</strong> Session profiles, milestone layouts, trigger templates, and uploaded trigger assets all live in <code>data/</code> and <code>public/assets/triggers/</code>, which are gitignored. Only default seed templates ship in the public repo via <code>services/templates-defaults.json</code>.</li>
      </ul>
      <p class="muted">Coming soon: mutual host ↔ host sessions. Today, device control is one-way (guest → host).</p>
    `,
  },
  {
    id: 'network',
    title: 'Network + Cloudflare',
    summary: 'Tunnel, DNS, Access app — what the wizard does and how to change it.',
    body: `
      <h4>What the wizard provisions</h4>
      <ul>
        <li>A Cloudflare Tunnel pointing at <code>localhost:3000</code> on this machine.</li>
        <li>A DNS CNAME on your chosen hostname (e.g. <code>pumpdirect.your-domain.com</code>) pointing at the tunnel.</li>
        <li>A Zero Trust Access application covering that hostname with an email-PIN allow-policy seeded from the Users tab.</li>
      </ul>
      <h4>Required token scopes</h4>
      <p>Create the CF API token with these permissions:</p>
      <ul>
        <li><strong>Account → Cloudflare Tunnel:</strong> Edit</li>
        <li><strong>Account → Access: Apps and Policies:</strong> Edit</li>
        <li><strong>Zone → DNS:</strong> Read</li>
      </ul>
      <h4>Changing hostnames</h4>
      <p>Edit the tunnel's public hostnames in the Cloudflare dashboard (Zero Trust → Networks → Tunnels) and update the Access application's hostname list. No code changes — PumpDirect doesn't pin its hostname anywhere in the repo.</p>
    `,
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting',
    summary: 'Common gotchas: cam, capacity, modals, age-gate, profile reset.',
    body: `
      <h4>"Visitors still see my cam after I turned it off"</h4>
      <p>Fixed in current build. If you see this on an old build, restart the owner server — <code>maybeAutoToggleCam</code> needs the rewritten transition logic.</p>
      <h4>"I have multiple owner tabs open and one stops working"</h4>
      <p>Only run one owner tab. The cam publisher is single-source; multiple tabs racing each other will mis-attribute state. Close the duplicates.</p>
      <h4>"Manual capacity edit got reset when I pressed an action button"</h4>
      <p>Fixed via <code>actionEngine.setCapacity()</code>. If still seen, the route is using a stale path — restart the owner server.</p>
      <h4>"Modals are unreadable in light mode"</h4>
      <p>Layout CSS now hits <code>#modal</code>, <code>.ae-row</code>, and the cancel button with theme vars and <code>!important</code>. If a new modal you've added shows the bug, give its root the <code>#modal</code> id or apply <code>background: var(--bg-2); color: var(--text);</code>.</p>
      <h4>"Visitor age-gate isn't reappearing"</h4>
      <p>It's keyed per session (by <code>state.startedAt</code>). If you're testing on the <em>same</em> session without restarting, the gate stays accepted. Stop and restart the session to re-trigger.</p>
      <h4>"Profile dropdown keeps resetting"</h4>
      <p>The fallback chain is <code>?profile=</code> URL param → last <code>session.sessionProfileId</code> → first profile in list. If it's resetting, your profile JSON probably got wiped — check <code>data/sessions.json</code>.</p>
      <h4>"Lottie disappeared mid-trigger"</h4>
      <p>Lottie is anchored to the host cam tile's bounds <em>captured at mount time</em>, so it survives the tile being destroyed (turn-off-host-cam, session end). If you still see it vanish, check the browser console for an overlay-stage error — the lottie file may be malformed.</p>
    `,
  },
  {
    id: 'distributing',
    title: 'Distributing your fork',
    summary: 'What ships as defaults, what stays personal.',
    body: `
      <h4>Ships as defaults (in the repo)</h4>
      <ul>
        <li><strong>18 standard pump action templates</strong> with descriptions — Slow Stream, Pulse, Sip, Soft Ramp, Tease, Slow Drip, Steady Push, Throb, Bounce, Sustain, Long Push, Hammer, Hold, Rapid Fire, Burst, Inferno, Overdrive, Saturate.</li>
        <li><strong>4 prize-wheel templates</strong> at escalating intensity — Easy Mode, Warm Up, Heat Up, Mercy is Dead.</li>
      </ul>
      <p>Source: <code>services/templates-defaults.json</code>. A fresh install seeds these on first boot.</p>
      <h4>Does NOT ship (stays in <code>data/</code>)</h4>
      <ul>
        <li>Personal pump-template profiles (the milestone layouts you build on the Pump Templates tab).</li>
        <li>Personal session profiles.</li>
        <li>Personal trigger templates, trigger actions, and trigger action groups.</li>
        <li>Uploaded trigger assets (Lottie JSON in <code>public/assets/triggers/lottie/</code>, audio in <code>public/assets/triggers/sound/</code>).</li>
        <li>Cloudflare credentials, account allowlist, device calibration.</li>
      </ul>
      <p>Everything in <code>data/</code> and the trigger asset folders is gitignored — your private library never enters the public repo.</p>
    `,
  },
];

function renderToc() {
  return SECTIONS.map(s =>
    `<li><a href="#${s.id}" class="help-toc-link" data-target="${s.id}">${escape(s.title)}</a></li>`
  ).join('');
}

function renderSections() {
  return SECTIONS.map(s => `
    <details class="help-section" id="${s.id}" data-search-id="${s.id}">
      <summary>
        <span class="help-section-title">${escape(s.title)}</span>
        <span class="help-section-summary muted">${escape(s.summary)}</span>
      </summary>
      <div class="help-section-body">${s.body}</div>
    </details>
  `).join('');
}

router.get('/help', (_req, res) => {
  const body = `
    <h2>Help</h2>
    <p class="muted">Comprehensive reference for the owner console. Use the search box to filter, or click a section in the quick links to jump.</p>

    <div class="card help-search-card">
      <input id="help-search" type="search" placeholder="Search help… (e.g. &quot;trigger&quot;, &quot;cam&quot;, &quot;cloudflare&quot;)" autocomplete="off">
      <div id="help-search-status" class="muted" style="margin-top:6px;font-size:0.9rem;min-height:1.2em"></div>
    </div>

    <div class="grid-2">
      <div class="card help-toc-card">
        <h3>Quick links</h3>
        <ul class="help-toc">${renderToc()}</ul>
        <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" onclick="helpExpandAll()">Expand all</button>
          <button type="button" onclick="helpCollapseAll()" style="background:#2a2f3a">Collapse all</button>
        </div>
      </div>
      <div class="card help-tips-card">
        <h3>Need more?</h3>
        <ul>
          <li>Source-of-truth docs: <code>README.md</code> in the repo root.</li>
          <li>TOS / legal text: <code>views/tos.js</code>.</li>
          <li>Action-engine internals: <code>services/action-engine.js</code>.</li>
          <li>Trigger runtime: <code>services/trigger-runtime.js</code>.</li>
        </ul>
        <p class="muted" style="font-size:0.9rem">Issue tracker: file in your fork's repo. Personal data never leaves this machine.</p>
      </div>
    </div>

    <div id="help-sections">${renderSections()}</div>

    <style>
      .help-search-card input { width: 100%; padding: 14px 16px !important; font-size: 1.05rem; }
      .help-toc { list-style: none; padding: 0; margin: 0; columns: 2; column-gap: 18px; }
      @media (max-width: 700px) { .help-toc { columns: 1; } }
      .help-toc li { break-inside: avoid; margin: 0 0 6px; }
      .help-toc a { color: var(--text); text-decoration: none; display: block; padding: 6px 10px; border-radius: 6px; border: 1px solid transparent; }
      .help-toc a:hover { background: var(--bg-3); border-color: var(--border); }
      .help-section { background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px; padding: 0 18px; margin-bottom: 10px; scroll-margin-top: 90px; }
      .help-section[open] { padding-bottom: 14px; }
      .help-section summary { list-style: none; padding: 16px 0; display: flex; flex-direction: column; gap: 4px; }
      .help-section summary::-webkit-details-marker { display: none; }
      .help-section summary::before {
        content: '▸'; display: inline-block; margin-right: 8px; color: var(--text-faint);
        transition: transform 0.15s ease; font-size: 0.85em;
      }
      .help-section[open] summary::before { transform: rotate(90deg); }
      .help-section-title { font-size: 1.15rem; font-weight: 600; }
      .help-section-summary { font-size: 0.95rem; }
      .help-section-body { padding: 4px 0 8px; line-height: 1.55; }
      .help-section-body h4 { margin-top: 16px; }
      .help-section-body ul, .help-section-body ol { padding-left: 22px; }
      .help-section-body li { margin: 4px 0; }
      .help-section.hide { display: none; }
      .help-toc-link.dim { opacity: 0.35; }
      .help-section mark { background: #f0c674; color: #1a1f2c; padding: 0 2px; border-radius: 3px; }
    </style>

    <script>
      (function() {
        const sections = Array.from(document.querySelectorAll('.help-section'));
        const tocLinks = Array.from(document.querySelectorAll('.help-toc-link'));
        const input = document.getElementById('help-search');
        const status = document.getElementById('help-search-status');

        // Cache normalized text per section (skip the body's HTML tags).
        const index = sections.map(sec => ({
          el: sec,
          id: sec.dataset.searchId,
          text: (sec.innerText || sec.textContent || '').toLowerCase(),
        }));
        const tocById = Object.fromEntries(tocLinks.map(a => [a.dataset.target, a]));

        function setStatus(msg) { status.textContent = msg || ''; }

        function applyFilter(q) {
          q = (q || '').trim().toLowerCase();
          if (!q) {
            index.forEach(({ el, id }) => {
              el.classList.remove('hide');
              el.open = false;
              if (tocById[id]) tocById[id].classList.remove('dim');
            });
            setStatus('');
            return;
          }
          let hits = 0;
          index.forEach(({ el, text, id }) => {
            const match = text.indexOf(q) !== -1;
            if (match) {
              el.classList.remove('hide');
              el.open = true;
              if (tocById[id]) tocById[id].classList.remove('dim');
              hits++;
            } else {
              el.classList.add('hide');
              el.open = false;
              if (tocById[id]) tocById[id].classList.add('dim');
            }
          });
          setStatus(hits === 0
            ? 'No matches for "' + q + '".'
            : hits + ' section' + (hits === 1 ? '' : 's') + ' matched.');
        }

        input.addEventListener('input', e => applyFilter(e.target.value));
        // Honor a ?q= deep link.
        const params = new URLSearchParams(location.search);
        const initial = params.get('q');
        if (initial) { input.value = initial; applyFilter(initial); }

        // Quick-link click: open the target + smooth scroll.
        tocLinks.forEach(a => {
          a.addEventListener('click', ev => {
            const id = a.dataset.target;
            const tgt = document.getElementById(id);
            if (!tgt) return;
            tgt.classList.remove('hide');
            tgt.open = true;
          });
        });

        // Initial deep-link via hash: open that section, leave others closed.
        if (location.hash) {
          const id = location.hash.slice(1);
          const tgt = document.getElementById(id);
          if (tgt && tgt.classList.contains('help-section')) {
            tgt.open = true;
            setTimeout(() => tgt.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
          }
        }

        window.helpExpandAll = function() { sections.forEach(s => { if (!s.classList.contains('hide')) s.open = true; }); };
        window.helpCollapseAll = function() { sections.forEach(s => { s.open = false; }); };
      })();
    </script>
  `;
  res.type('html').send(ownerLayout({ title: 'Help', active: 'help', body }));
});

module.exports = router;
