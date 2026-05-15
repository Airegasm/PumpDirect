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
  { id: 'network', label: 'Network', href: '/network' },
  { id: 'users', label: 'Users', href: '/users' },
];

function ownerLayout({ title, active, body }) {
  const tabs = TABS.map(t =>
    `<a href="${t.href}" class="tab ${active === t.id ? 'active' : ''}">${escape(t.label)}</a>`
  ).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(title)} — PumpDirect Owner</title>
<style>
  :root { color-scheme: dark; font-size: 20px; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e8e8e8; margin: 0; font-size: 1rem; line-height: 1.5; }
  input, select, textarea { font-size: 1rem; font-family: inherit; }
  .topbar { background: #161922; padding: 18px 32px; border-bottom: 1px solid #2a2f3a; display: flex; align-items: center; justify-content: space-between; }
  .topbar h1 { font-size: 1.4rem; margin: 0; font-weight: 600; }
  .tabs { display: flex; gap: 0; background: #0f1115; border-bottom: 1px solid #2a2f3a; padding: 0 32px; }
  .tab { color: #9aa4b2; text-decoration: none; padding: 18px 24px; font-size: 1.1rem; border-bottom: 3px solid transparent; margin-bottom: -1px; }
  .tab:hover { color: #e8e8e8; background: #161922; }
  .tab.active { color: #fff; border-bottom-color: #2a6df4; background: #161922; }
  main { max-width: 1200px; margin: 0 auto; padding: 36px 32px; }
  h2 { font-size: 2rem; margin-top: 0; }
  h3 { font-size: 1.3rem; margin: 0 0 16px; }
  h4 { font-size: 1.1rem; margin: 16px 0 8px; }
  .card { background: #161922; border: 1px solid #2a2f3a; border-radius: 10px; padding: 28px; margin-bottom: 24px; }
  .pill { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 0.9rem; }
  .pill.ok { background: #133d2b; color: #6ddc9b; }
  .pill.warn { background: #4a3413; color: #f0c674; }
  .pill.bad { background: #4a1b1b; color: #f08484; }
  button, .btn { background: #2a6df4; color: #fff; border: 0; border-radius: 8px; padding: 12px 22px; font-size: 1rem; font-family: inherit; cursor: pointer; text-decoration: none; display: inline-block; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  code { background: #0a0c10; padding: 3px 8px; border-radius: 4px; font-size: 0.95rem; }
  pre { background: #0a0c10; padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 0.95rem; }
  .muted, .muted * { color: #7a8597; }
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
  .pump-status { font-size: 1.05rem; font-weight: 600; margin: 8px 0 0; min-height: 1.5em; color:#e8e8e8; }
  .pump-status .pump-state { color: #6ddc9b; }
  .pump-status.idle .pump-state { color: #7a8597; }
  .pump-status .pump-count { color: #f0c674; margin-left: 4px; font-weight: 500; }
  .cycle-status { font-size: 0.9rem; color: #f0c674; margin: 2px 0 0; min-height: 1.1em; }
  .milestone-pane .milestone-title { font-size: 1.35rem; font-weight: 700; margin: 0 0 6px; }
  .milestone-pane .milestone-announcement { font-size: 1.05rem; line-height: 1.45; margin: 0 0 14px; color: #e8e8e8; }
  .milestone-pane .action-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
  .milestone-pane .action-grid button { min-height: 54px; padding: 10px 14px; }
  .cam-grid { display: flex; justify-content: center; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; width: 100%; }
  .cam-grid .cam-slot { flex: 1 1 0; min-width: 0; max-width: min(85vh, 80vw); display: flex; flex-direction: column; gap: 10px; align-items: stretch; }
  .cam-grid .cam-slot:empty { display: none; }
  .cam-tile { width: 100%; aspect-ratio: 1; background:#0a0c10; border:1px solid #2a2f3a; border-radius:14px; overflow:hidden; position:relative; }
  .cam-tile video { width:100%; height:100%; object-fit:cover; }
  .cam-tile .rt-label { position:absolute; bottom:10px; left:12px; background:rgba(0,0,0,0.65); padding:5px 12px; border-radius:6px; font-size:1rem; }
  .cam-tile .rt-ctrls { position:absolute; top:10px; right:10px; display:flex; gap:6px; }
  .cam-tile .rt-ctrls button { background:rgba(0,0,0,0.6); border:0; color:#fff; border-radius:6px; padding:6px 10px; font-size:1rem; cursor:pointer; }
  .cam-tile.muted-video video { visibility: hidden; }
  .chat-row { display: grid; grid-template-columns: 1fr 260px; gap: 14px; }
  .chat-row > .card { margin: 0; display: flex; flex-direction: column; }
  .chat-pane .chat-log { flex: 1; min-height: 320px; max-height: 60vh; overflow-y: auto; background:#0a0c10; border:1px solid #2a2f3a; border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:8px; }
  .chat-pane .chat-input-row { margin-top: 10px; display:flex; gap:8px; }
  .chat-pane .chat-input-row input { flex:1; }
  .participants-pane .p-list { display: flex; flex-direction: column; gap: 4px; max-height: 56vh; overflow-y: auto; }
  .participants-pane .p-item { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background:#0a0c10; border:1px solid #2a2f3a; border-radius:6px; font-size: 0.92rem; }
  .participants-pane .p-flags { margin-left: auto; display: flex; gap: 2px; font-size: 0.75rem; }
  .participants-pane .p-flags label { display: inline-flex; align-items: center; gap: 1px; }
  .participants-pane .p-flags input { transform: scale(0.85); margin: 0 1px; }
  .presence-dot { width: 8px; height: 8px; border-radius: 50%; background: #7a8597; flex-shrink: 0; }
  .presence-dot.online { background: #6ddc9b; }
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
  details summary { cursor: pointer; padding: 8px 0; font-size: 1.05rem; }
  input[type="text"], input[type="email"], input[type="password"], input[type="number"], select {
    padding: 10px 12px !important; background: #0a0c10 !important; color: #e8e8e8 !important;
    border: 1px solid #2a2f3a !important; border-radius: 6px !important;
  }
</style>
</head>
<body>
<div class="topbar">
  <h1>PumpDirect <span class="muted">— owner console</span></h1>
  <span class="muted" style="font-size:0.9rem">loopback only</span>
</div>
<div class="tabs">${tabs}</div>
<main>${body}</main>
</body>
</html>`;
}

function splash({ user }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PumpDirect</title>
<style>
  :root { font-size: 20px; }
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e8e8e8; margin: 0; display: grid; place-items: center; min-height: 100vh; font-size: 1rem; line-height: 1.5; }
  .splash { text-align: center; padding: 60px; }
  h1 { font-size: 3rem; margin: 0 0 20px; }
  p { color: #9aa4b2; font-size: 1.1rem; }
</style>
</head>
<body>
<div class="splash">
  <h1>Welcome to PumpDirect</h1>
  <p>Signed in as <strong>${escape(user)}</strong></p>
  <p class="muted">Visitor experience coming soon.</p>
</div>
</body>
</html>`;
}

module.exports = { ownerLayout, splash, escape };
