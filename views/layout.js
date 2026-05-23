const session = require('../services/session-service');
const { fetchShimJs } = require('../utils/csrf');

function escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const TABS = [
  { id: 'launchpad', label: 'Launchpad', href: '/' },
  { id: 'chatwebcam', label: 'Chat/Webcam', href: '/chat-webcam' },
  { id: 'templates', label: 'Pump Templates', href: '/templates' },
  { id: 'devices', label: 'Device Discovery', href: '/devices' },
  { id: 'triggers', label: 'Triggers', href: '/triggers' },
  { id: 'minigames', label: 'Mini Games', href: '/minigames' },
  { id: 'network', label: 'Network', href: '/network' },
  { id: 'users', label: 'Users', href: '/users' },
  { id: 'system', label: 'System', href: '/system' },
  { id: 'help', label: 'Help', href: '/help' },
];

function ownerLayout({ title, active, body }) {
  // During a live session, every Launchpad tab owns a webcam + WebRTC mesh that
  // dies if the tab navigates away. Send non-launchpad tabs to a fresh window
  // so the Launchpad tab stays mounted and visitors keep their feed.
  const live = !!session.getState().active;
  const tabs = TABS.map(t => {
    const isActive = active === t.id;
    const openNewTab = live && t.id !== 'launchpad' && active === 'launchpad';
    const targetAttr = openNewTab ? ' target="_blank" rel="noopener"' : '';
    const liveSuffix = openNewTab ? ' <span aria-hidden="true" style="opacity:0.55;font-size:0.85em">↗</span>' : '';
    const titleAttr = openNewTab ? ' title="Opens in a new window — leaving Launchpad would drop the live cam feed."' : '';
    return `<a href="${t.href}" class="tab ${isActive ? 'active' : ''}"${targetAttr}${titleAttr}>${escape(t.label)}${liveSuffix}</a>`;
  }).join('');
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<title>${escape(title)} — PumpDirect Owner</title>
<script>
  (function() { try { var t = localStorage.getItem('pd-theme') || 'dark'; document.documentElement.setAttribute('data-theme', t); } catch (e) {} })();
</script>
<style>
  :root {
    color-scheme: dark; font-size: 20px;
    --bg: #0f1115; --bg-2: #161922; --bg-3: #0a0c10;
    --border: #2a2f3a; --text: #e8e8e8; --text-muted: #9aa4b2; --text-faint: #7a8597;
    --accent: #2a6df4;
  }
  [data-theme="light"] {
    color-scheme: light;
    --bg: #f5f7fa; --bg-2: #ffffff; --bg-3: #eef0f5;
    --border: #d4d9e2; --text: #1a1f2c; --text-muted: #4b5563; --text-faint: #6b7280;
    --accent: #2a6df4;
  }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; font-size: 1rem; line-height: 1.5; }
  input, select, textarea { font-size: 1rem; font-family: inherit; }
  .topbar { background: var(--bg-2); padding: 18px 32px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .topbar h1 { font-size: 1.4rem; margin: 0; font-weight: 600; }
  .theme-toggle { background: transparent; color: var(--text); border: 1px solid var(--border); border-radius: 999px; width: 38px; height: 38px; cursor: pointer; padding: 0; font-size: 1rem; }
  .theme-toggle:hover { background: var(--bg-3); }
  .tabs { display: flex; gap: 0; background: var(--bg); border-bottom: 1px solid var(--border); padding: 0 32px; }
  .tab { color: var(--text-muted); text-decoration: none; padding: 18px 24px; font-size: 1.1rem; border-bottom: 3px solid transparent; margin-bottom: -1px; }
  .tab:hover { color: var(--text); background: var(--bg-2); }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); background: var(--bg-2); }
  main { max-width: 1200px; margin: 0 auto; padding: 36px 32px; }
  h2 { font-size: 2rem; margin-top: 0; }
  h3 { font-size: 1.3rem; margin: 0 0 16px; }
  h4 { font-size: 1.1rem; margin: 16px 0 8px; }
  .card { background: var(--bg-2); border: 1px solid var(--border); border-radius: 10px; padding: 28px; margin-bottom: 24px; }
  .pill { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 0.9rem; }
  .pill.ok { background: #133d2b; color: #6ddc9b; }
  .pill.warn { background: #4a3413; color: #f0c674; }
  .pill.bad { background: #4a1b1b; color: #f08484; }
  button, .btn { background: #2a6df4; color: #fff; border: 0; border-radius: 8px; padding: 12px 22px; font-size: 1rem; font-family: inherit; cursor: pointer; text-decoration: none; display: inline-block; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  code { background: var(--bg-3); padding: 3px 8px; border-radius: 4px; font-size: 0.95rem; color: var(--text); }
  pre { background: var(--bg-3); padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.95rem; color: var(--text); }
  .muted, .muted * { color: var(--text-faint); }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } }
  table { font-size: 1rem; }
  th, td { padding: 10px 4px; }
  /* Universal layout — compact + functional defaults for the owner GUI */
  main { padding: 22px 28px; max-width: 1400px; }
  .card { padding: 18px; margin-bottom: 14px; }
  h2 { font-size: 1.6rem; margin-top: 0; margin-bottom: 14px; }
  h3 { font-size: 1.15rem; margin: 0 0 12px; }
  .top-row { display: grid; grid-template-columns: 300px 1fr; gap: 14px; align-items: stretch; margin-bottom: 14px; }
  .top-row > .card { margin: 0; }
  .gauge-card { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  /* ====== Three-column launchpad layout ======
     Left sidebar (session controls + gauge) | center (cams + chat) | right sidebar
     (current milestone + action buttons). Sidebar width pins to ~280px so the
     240px gauge fits with normal card padding; columns match each other. Collapses
     to a single stacked column below 1100px viewport. */
  .lp-grid { display: grid; grid-template-columns: 280px minmax(0, 1fr) 280px; gap: 16px; align-items: stretch; margin-bottom: 14px; }
  .lp-grid > .card { margin: 0; }
  .lp-grid .lp-col-left  { display: flex; flex-direction: column; gap: 10px; }
  .lp-grid .lp-col-right { display: flex; flex-direction: column; gap: 10px; }
  .lp-grid .lp-col-left .session-controls { display: flex; flex-direction: column; gap: 8px; }
  .lp-grid .lp-col-left .session-controls button { width: 100%; padding: 10px 14px; font-size: 0.95rem; }
  .lp-grid .lp-col-left .session-divider { height: 1px; background: var(--border); margin: 4px 0; }
  .lp-grid .lp-col-left .lp-gauge-wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .lp-grid .lp-col-right .lp-milestone-title { font-size: 1.2rem; font-weight: 700; margin: 0 0 4px; }
  .lp-grid .lp-col-right .lp-milestone-range { font-size: 0.85rem; color: var(--text-muted); margin: 0 0 12px; }
  .lp-grid .lp-col-right .action-list { display: flex; flex-direction: column; gap: 6px; }
  .lp-grid .lp-col-right .action-list .action-cell { position: relative; display: flex; }
  .lp-grid .lp-col-right .action-list .action-cell .action-btn { flex: 1; min-height: 50px; padding: 10px 36px 10px 12px; width: 100%; font-size: 0.95rem; }
  .lp-grid .lp-col-right .action-list .action-btn { min-height: 50px; padding: 10px 14px; font-size: 0.95rem; }
  @media (max-width: 1100px) {
    .lp-grid { grid-template-columns: 1fr; }
  }
  /* In-tile placeholder Start camera button (replaces the old text-button row) */
  .cam-tile .placeholder-cam-btn { background:#2a6df4; color:#fff; border:0; border-radius:10px; padding:12px 20px; font-size:1rem; cursor:pointer; font-family:inherit; }
  .cam-tile .placeholder-cam-btn:hover { background:#3b7df8; }
  .cam-tile .local-ctrls button.muted { background:rgba(74,52,19,0.9); color:#f0c674; }
  .pump-status { font-size: 1.05rem; font-weight: 600; margin: 8px 0 0; min-height: 1.5em; color:#e8e8e8; }
  .pump-status .pump-state { color: #6ddc9b; }
  .pump-status.idle .pump-state { color: #7a8597; }
  .pump-status .pump-count { color: #f0c674; margin-left: 4px; font-weight: 500; }
  .cycle-status { font-size: 0.9rem; color: #f0c674; margin: 2px 0 0; min-height: 1.1em; }
  .milestone-pane .milestone-title { font-size: 1.35rem; font-weight: 700; margin: 0 0 6px; }
  .milestone-pane .milestone-welcome { font-size: 1.05rem; line-height: 1.45; margin: 0 0 8px; color: var(--text); }
  .milestone-pane .milestone-announcement { font-size: 1rem; line-height: 1.45; margin: 0 0 14px; color: var(--text-muted); border-left: 3px solid var(--accent); padding: 4px 12px; background: var(--bg-3); border-radius: 0 8px 8px 0; }
  .milestone-pane .milestone-announcement:empty { display: none; }
  .milestone-pane .action-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
  .milestone-pane .action-grid > button { min-height: 54px; padding: 10px 14px; }
  .milestone-pane .action-grid .action-cell { position: relative; display: flex; }
  .milestone-pane .action-grid .action-cell .action-btn { flex: 1; min-height: 54px; padding: 10px 36px 10px 14px; width: 100%; }
  .action-help-btn { position: absolute; top: 4px; right: 4px; width: 26px; height: 26px; padding: 0; border-radius: 50%; background: rgba(0,0,0,0.45); color: #fff; border: 1px solid rgba(255,255,255,0.2); font-size: 0.85rem; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .action-help-btn:hover { background: rgba(0,0,0,0.75); }
  .cam-grid { display: flex; justify-content: center; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; width: 100%; }
  /* Slot flex-grow scales with the published cam's aspect ratio so all tiles
     render at the same HEIGHT regardless of aspect. A 16:9 host cam (1.78)
     paired with a 1:1 visitor cam (1.0) gets ~64% / 36% of the row, which
     keeps the host visually dominant instead of squat next to a square. */
  .cam-grid .cam-slot { flex: var(--cam-aspect, 1) 1 0%; min-width: 0; max-width: min(85vh, 80vw); display: flex; flex-direction: column; gap: 10px; align-items: stretch; }
  .cam-grid .cam-slot:empty { display: none; }
  /* ====== Dual-Target mode layout ====== */
  /* Wide cam-pair stack — vertical pairs, each cam tile with a bare gauge
     floating to the right (partially overlapping). Mobile reflow shrinks
     gauges into top-right corner chips. */
  .dual-controls-row { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; padding: 6px 0; margin-bottom: 12px; }
  .dual-cam-stack { display: flex; flex-direction: column; gap: 20px; margin-bottom: 14px; }
  .cam-pair { position: relative; width: 100%; }
  .cam-pair .cam-slot.wide { width: 100%; max-width: none; }
  .cam-pair .cam-slot.wide .cam-buttons { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-top: 8px; }
  .cam-pair .gauge-float {
    position: absolute; right: -8px; top: 12px;
    background: rgba(22, 25, 34, 0.92);
    border: 1px solid var(--border); border-radius: 12px;
    padding: 8px 12px 10px;
    box-shadow: 0 4px 18px rgba(0,0,0,0.45);
    z-index: 5;
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    pointer-events: auto;
  }
  .cam-pair .gauge-float svg { width: 150px; height: 150px; }
  .cam-pair .gauge-float .gauge-name { font-weight: 600; font-size: 0.92rem; color: var(--text); margin-bottom: 2px; }
  .cam-pair .gauge-float .pump-status { font-size: 0.85rem; min-height: 1em; }
  .cam-pair .gauge-float .pump-status .pump-state { font-weight: 600; }
  .cam-pair .gauge-float .pump-status.idle .pump-state { color: var(--text-faint); }
  .cam-pair .gauge-float .set-cap-btn {
    background: transparent; border: 1px solid var(--border); color: var(--text-muted);
    padding: 2px 8px; font-size: 0.8rem; margin-top: 4px; border-radius: 999px;
  }
  /* The host cam tile in dual mode (cam-slot.wide) takes the full width;
     keep its --cam-aspect so 16:9 looks natural rather than square. */
  .cam-pair .cam-slot.wide .cam-tile { width: 100%; aspect-ratio: var(--cam-aspect, 16/9); }
  @media (max-width: 900px) {
    /* On mobile the gauge becomes a chip overlay in the top-right corner. */
    .cam-pair .gauge-float {
      right: 8px; top: 8px;
      padding: 4px 6px 5px;
      background: rgba(15, 17, 21, 0.85);
      backdrop-filter: blur(4px);
    }
    .cam-pair .gauge-float svg { width: 84px; height: 84px; }
    .cam-pair .gauge-float .gauge-name { font-size: 0.75rem; }
    .cam-pair .gauge-float .pump-status { font-size: 0.75rem; }
    .cam-pair .gauge-float .set-cap-btn { display: none; }
  }
  /* Compact milestone in dual mode (smaller welcome + title + announcement) */
  .milestone-pane.mini .milestone-title { font-size: 1.1rem; margin: 0 0 4px; }
  .milestone-pane.mini .milestone-welcome { font-size: 0.95rem; margin: 0 0 4px; }
  .milestone-pane.mini .milestone-announcement { font-size: 0.9rem; margin: 0 0 8px; padding: 3px 8px; }
  /* A/B toggle pill — picks which pump the next button press fires on. */
  .ab-toggle { display: inline-flex; background: var(--bg-3); border: 1px solid var(--border); border-radius: 999px; padding: 3px; gap: 3px; margin: 0 0 10px; }
  .ab-toggle .ab-btn { background: transparent; color: var(--text-muted); border: 0; padding: 6px 14px; border-radius: 999px; cursor: pointer; font-weight: 600; font-size: 0.92rem; transition: background 0.12s ease, color 0.12s ease; line-height: 1.15; }
  .ab-toggle .ab-btn.active { background: var(--accent); color: #fff; }
  .ab-toggle .ab-btn:not(.active):hover { color: var(--text); }
  .ab-toggle .ab-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
  /* Mutual-consent banner for dual-target session start. */
  .dual-consent-bar { display: flex; gap: 14px; align-items: center; justify-content: center; flex-wrap: wrap; padding: 12px 16px; margin: 0 0 14px; border: 1px solid #b88dff; background: rgba(123, 63, 214, 0.12); border-radius: 12px; }
  .dual-consent-bar .status { font-size: 0.98rem; color: var(--text); }
  .dual-consent-bar .consent-btn { background: #2a8a6d; color: #fff; border: 0; border-radius: 999px; padding: 8px 22px; font-size: 0.95rem; font-weight: 700; cursor: pointer; }
  .dual-consent-bar .consent-btn:hover { background: #34a584; }
  .dual-consent-bar .muted { font-size: 0.9rem; color: var(--text-muted); }
  .cam-tile { width: 100%; aspect-ratio: var(--cam-aspect, 1); background:#0a0c10; border:1px solid #2a2f3a; border-radius:14px; overflow:hidden; position:relative; }
  .cam-tile video { width:100%; height:100%; object-fit:cover; }
  .cam-tile .rt-label { position:absolute; bottom:10px; left:12px; background:rgba(0,0,0,0.65); padding:5px 12px; border-radius:6px; font-size:1rem; }
  .cam-tile .rt-ctrls { position:absolute; top:10px; right:10px; display:flex; gap:6px; }
  .cam-tile .rt-ctrls button { background:rgba(0,0,0,0.6); border:0; color:#fff; border-radius:6px; padding:6px 10px; font-size:1rem; cursor:pointer; }
  .cam-tile.muted-video video { visibility: hidden; }
  .chat-row { display: grid; grid-template-columns: 1fr 520px; gap: 14px; }
  /* When chat-row sits inside the narrower lp-col-center (single-target
     launchpad layout), the participants pane stops fighting cams for width. */
  .lp-col-center .chat-row { grid-template-columns: minmax(0, 1fr) minmax(240px, 360px); margin-top: 14px; }
  .chat-row > .card { margin: 0; display: flex; flex-direction: column; }
  .chat-pane .chat-log { flex: 1; min-height: 320px; max-height: 60vh; overflow-y: auto; background:var(--bg-3); border:1px solid var(--border); border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:8px; }
  .chat-pane .chat-input-row { margin-top: 10px; display:flex; gap:8px; }
  .chat-pane .chat-input-row input { flex:1; }
  /* Flex-column the whole pane so the legend can pin to the bottom via
     .p-legend { margin-top: auto } regardless of how many participants
     are in the list. */
  .participants-pane { display: flex; flex-direction: column; }
  .participants-pane .p-list { display: flex; flex-direction: column; gap: 4px; max-height: 56vh; overflow-y: auto; flex: 0 1 auto; }
  .participants-pane .p-legend { margin-top: auto; }
  .participants-pane .p-legend p { margin: 0; }
  .participants-pane .p-legend p + p { margin-top: 4px; }
  .participants-pane .p-item { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background:var(--bg-3); border:1px solid var(--border); border-radius:6px; font-size: 0.92rem; }
  .participants-pane .p-flags { margin-left: auto; display: flex; gap: 2px; font-size: 0.75rem; }
  .participants-pane .p-flags label { display: inline-flex; align-items: center; gap: 1px; }
  .participants-pane .p-flags input { transform: scale(0.85); margin: 0 1px; }
  .presence-dot { width: 8px; height: 8px; border-radius: 50%; background: #7a8597; flex-shrink: 0; }
  .presence-dot.online { background: #6ddc9b; }
  .presence-dot.afk { background: #f0c674; }
  .participants-pane .p-item.afk { font-style: italic; opacity: 0.8; }
  .session-pill { padding: 5px 14px; border-radius: 999px; font-size: 0.95rem; font-weight: 600; text-decoration: none; }
  .session-pill.idle { background: #2a2f3a; color: #9aa4b2; }
  .session-pill.ok { background: #133d2b; color: #6ddc9b; }
  .session-pill.warn { background: #4a3413; color: #f0c674; }
  .session-pill.bad { background: #4a1b1b; color: #f08484; }
  @media (max-width: 900px) {
    .top-row { grid-template-columns: 1fr; }
    .chat-row { grid-template-columns: 1fr; }
    .cam-grid .cam-slot { max-width: 100%; }
  }
  /* Standby: blacks out every cam tile in place. Visual + the publisher's
     outgoing tracks get disabled in JS so no real frames travel. */
  #session-stage { position: relative; }
  .cam-tile.standby-blackout video,
  .cam-tile.peer-video-muted video { visibility: hidden; }
  .cam-tile.peer-video-muted::after {
    content: "VIDEO MUTED";
    position: absolute; inset: 0; background: #000;
    display: flex; align-items: center; justify-content: center;
    color: #555; font-weight: 700; font-size: 1.1rem; letter-spacing: 0.15em; z-index: 2;
  }
  /* Standby supersedes a per-peer mute — both apply, standby's label wins. */
  .cam-tile.standby-blackout::after {
    content: "STANDBY";
    position: absolute; inset: 0; background: #000;
    display: flex; align-items: center; justify-content: center;
    color: #4a3413; font-weight: 900; font-size: 1.5rem; letter-spacing: 0.2em; z-index: 3;
  }
  .cam-tile.standby-blackout .rt-ctrls, .cam-tile.standby-blackout .rt-label,
  .cam-tile.peer-video-muted .rt-ctrls, .cam-tile.peer-video-muted .rt-label { z-index: 4; }
  .cam-tile .audio-muted-badge {
    display: none; position: absolute; bottom: 10px; right: 10px;
    background: rgba(0,0,0,0.7); border-radius: 50%; width: 32px; height: 32px;
    display: none; align-items: center; justify-content: center;
    font-size: 1rem; z-index: 5;
  }
  .cam-tile.peer-audio-muted .audio-muted-badge { display: flex; }
  details summary { cursor: pointer; padding: 8px 0; font-size: 1.05rem; }
  input[type="text"], input[type="email"], input[type="password"], input[type="number"], select, textarea {
    padding: 10px 12px !important; background: var(--bg-3) !important; color: var(--text) !important;
    border: 1px solid var(--border) !important; border-radius: 6px !important;
  }
  /* Modal cards (every owner page uses an inline #modal element with
     hardcoded dark colors) — override with theme vars so light mode reads. */
  #modal { background: var(--bg-2) !important; border: 1px solid var(--border) !important; color: var(--text) !important; }
  #modal h2, #modal h3, #modal h4, #modal-body { color: var(--text); }
  #modal-body { color: var(--text); }
  #modal-body code, #modal-body pre { background: var(--bg-3) !important; color: var(--text) !important; }
  #modal-body .ae-row { background: var(--bg-3) !important; border-color: var(--border) !important; color: var(--text) !important; }
  #modal-body .ae-nested { border-left-color: var(--border) !important; }
  /* Generic "secondary" / cancel button: inline-styled with #2a2f3a — works
     on dark but reads as muddy gray-on-gray in light. Honour the theme vars. */
  #modal-bg button[style*="#2a2f3a"], #modal-bg button[style*="background:#2a2f3a"] {
    background: var(--bg-3) !important; color: var(--text) !important; border: 1px solid var(--border) !important;
  }
</style>
</head>
<body>
<div class="topbar">
  <h1>PumpDirect <span class="muted">— host console</span></h1>
  <div style="display:flex;gap:12px;align-items:center">
    <a id="session-indicator" href="/" class="session-pill idle" title="jump to Launchpad">○ idle</a>
    <button id="update-pill" onclick="showUpdateModal()" title="An update is available — click for the commands" style="display:none;background:#4a3413;color:#f0c674;border:1px solid #f0c674;border-radius:6px;padding:8px 14px;font-size:0.9rem;cursor:pointer">↗ Update available</button>
    <button onclick="hostRestart()" title="Restart the backend. Under the OS-hardened service or NSSM, the supervisor will bring it back. Under start.sh/start.bat the launcher will exit." style="background:#2a2f3a;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:6px;padding:8px 14px;font-size:0.9rem;cursor:pointer">↻ Restart</button>
    <button onclick="hostExit()" title="Shut down the backend. systemd stays down. Windows Service (NSSM default) may auto-restart — use Stop-Service PumpDirect from admin PowerShell to truly stop." style="background:#4a1b1b;color:#f0c674;border:1px solid #4a1b1b;border-radius:6px;padding:8px 14px;font-size:0.9rem;cursor:pointer">⏻ Exit</button>
    <button id="theme-toggle" class="theme-toggle" onclick="toggleTheme()" title="toggle light/dark">🌙</button>
  </div>
</div>
<div id="update-modal-bg" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:10000;align-items:center;justify-content:center;padding:24px" onclick="if(event.target===this)closeUpdateModal()">
  <div style="background:#161922;border:1px solid #2a2f3a;border-radius:12px;padding:28px 32px;max-width:680px;width:100%;max-height:90vh;overflow:auto">
    <h2 style="margin:0 0 12px;font-size:1.4rem;color:#f0c674">↗ Update available</h2>
    <p id="update-modal-summary" style="margin:0 0 16px;color:#9aa4b2"></p>
    <div id="update-modal-cmd-wrap" style="margin-bottom:16px"></div>
    <p style="margin:0 0 18px;color:#7a8597;font-size:0.9rem">Updates are pulled from GitHub. The launcher scripts (start.sh / start.bat) also auto-pull on every run — these commands are for users running the OS-hardened service (which doesn't run the launcher).</p>
    <p style="margin:0;text-align:right"><button onclick="closeUpdateModal()" style="background:#2a2f3a;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:6px;padding:8px 18px;font-size:0.95rem;cursor:pointer">Close</button></p>
  </div>
</div>
<div class="tabs">${tabs}</div>
<main>${body}</main>
<script>${fetchShimJs()}</script>
<script>
function toggleTheme() {
  var cur = document.documentElement.getAttribute('data-theme') || 'dark';
  var next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('pd-theme', next); } catch (e) {}
  var btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = next === 'light' ? '☀️' : '🌙';
}
(function() {
  var btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = (document.documentElement.getAttribute('data-theme') === 'light') ? '☀️' : '🌙';
})();
async function hostRestart() {
  if (!confirm('Restart the PumpDirect server?\\n\\nAny active session will be interrupted. The page will reload automatically once the backend is back.')) return;
  try {
    const r = await fetch('/api/system/restart', { method: 'POST' });
    if (!r.ok) { alert('Restart request failed.'); return; }
    document.body.style.opacity = '0.4';
    document.body.style.pointerEvents = 'none';
    var n = 0;
    var poll = setInterval(async () => {
      n++;
      try { const p = await fetch('/api/launchpad/state', { cache: 'no-store' }); if (p.ok) { clearInterval(poll); location.reload(); return; } } catch {}
      if (n > 30) { clearInterval(poll); alert('Server did not come back within 30s. You may need to start it manually.'); }
    }, 1000);
  } catch (e) { alert('Restart request failed: ' + e.message); }
}
let __updateState = null;
async function checkForUpdates() {
  try {
    const r = await fetch('/api/owner/update-check', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    __updateState = d;
    const pill = document.getElementById('update-pill');
    if (pill && d.info && d.info.behind > 0) pill.style.display = '';
    else if (pill) pill.style.display = 'none';
  } catch {}
}
function escUpd(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function showUpdateModal() {
  const bg = document.getElementById('update-modal-bg');
  const sum = document.getElementById('update-modal-summary');
  const wrap = document.getElementById('update-modal-cmd-wrap');
  if (!__updateState || !__updateState.info) return;
  const info = __updateState.info;
  const cmd = __updateState.commands;
  sum.innerHTML = 'You are <strong>' + info.behind + ' commit' + (info.behind === 1 ? '' : 's') + '</strong> behind <code>origin/main</code>. Current: <code>' + escUpd(info.currentSha || '') + '</code>';
  if (cmd && cmd.cmd) {
    wrap.innerHTML =
      '<div style="padding:14px;background:#0a0c10;border:1px solid #2a2f3a;border-radius:8px">' +
      '<div style="color:#9aa4b2;font-size:0.9rem;margin-bottom:8px">' +
      '<strong>' + escUpd(cmd.scope) + '</strong> — run in <em>' + escUpd(cmd.shell) + '</em>:' +
      '</div>' +
      '<pre id="upd-cmd-pre" style="margin:0;padding:12px;background:#161922;border-radius:6px;font-size:0.9rem;line-height:1.55;white-space:pre-wrap;word-break:break-all;color:#e8e8e8">' + escUpd(cmd.cmd) + '</pre>' +
      '<p style="margin:10px 0 0"><button id="upd-copy-btn" onclick="copyUpdateCmd()" style="background:#2a6df4;color:#fff;border:0;border-radius:6px;padding:8px 16px;font-size:0.9rem;cursor:pointer">Copy</button></p>' +
      (cmd.note ? '<p style="margin:10px 0 0;color:#7a8597;font-size:0.85rem;font-style:italic">' + escUpd(cmd.note) + '</p>' : '') +
      '</div>';
  } else {
    wrap.innerHTML = '<p style="color:#9aa4b2">Run <code>git pull && npm install</code> from the project directory and restart PumpDirect.</p>';
  }
  bg.style.display = 'flex';
}
function closeUpdateModal() { document.getElementById('update-modal-bg').style.display = 'none'; }
function copyUpdateCmd() {
  const pre = document.getElementById('upd-cmd-pre');
  const btn = document.getElementById('upd-copy-btn');
  if (!pre) return;
  navigator.clipboard.writeText(pre.textContent).then(() => {
    if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
  });
}
checkForUpdates();
setInterval(checkForUpdates, 60 * 60 * 1000); // hourly client-side; backend caches 1h too.
async function hostExit() {
  if (!confirm('Shut down the PumpDirect server?\\n\\nNote: if you installed the OS-hardened Windows Service, NSSM may auto-restart it. To truly stop on Windows, use:\\n  Stop-Service PumpDirect\\nin an admin PowerShell window.\\n\\nContinue?')) return;
  try {
    const r = await fetch('/api/system/exit', { method: 'POST' });
    if (!r.ok) { alert('Shutdown request failed.'); return; }
    document.body.innerHTML = '<div style="padding:60px;text-align:center;font-family:system-ui,sans-serif;color:#e8e8e8;background:#0f1115;min-height:100vh"><h2 style="font-size:1.6rem;margin:0 0 18px">PumpDirect is shutting down…</h2><p style="color:#9aa4b2;font-size:1.05rem;max-width:560px;margin:0 auto">If it comes back on its own, the OS-hardened service (systemd / NSSM) auto-restarted it. To truly stop on Windows: <code style="background:#161922;padding:2px 8px;border-radius:4px">Stop-Service PumpDirect</code> in admin PowerShell. On Linux: <code style="background:#161922;padding:2px 8px;border-radius:4px">sudo systemctl stop pumpdirect</code>.</p></div>';
  } catch (e) { alert('Shutdown request failed: ' + e.message); }
}
(function() {
  const el = document.getElementById('session-indicator');
  if (!el) return;
  async function poll() {
    try {
      const r = await fetch('/api/launchpad/state');
      if (!r.ok) return;
      const { state } = await r.json();
      const cls = state.active ? (state.emergencyStopped ? 'bad' : state.paused ? 'warn' : 'ok') : 'idle';
      const cap = Math.round(state.capacity || 0);
      const txt = state.active
        ? (state.emergencyStopped ? '⛔ E-STOP'
          : state.paused ? '⏸ Standby · ' + cap + '%'
          : '● Live · ' + cap + '%')
        : '○ idle';
      el.className = 'session-pill ' + cls;
      el.textContent = txt;
    } catch {}
  }
  poll();
  setInterval(poll, 4000);
})();
</script>
</body>
</html>`;
}

module.exports = { ownerLayout, escape };
