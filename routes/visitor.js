const express = require('express');
const session = require('../services/session-service');
const templatesSvc = require('../services/templates-service');
const actionEngine = require('../services/action-engine');
const minigames = require('../services/minigames-service');
const chat = require('../services/chat-service');
const config = require('../config');
const { rtcClientJs } = require('../views/rtc-client');
const { chatCryptoJs } = require('../views/chat-crypto');
const { overlayJs, overlayCss } = require('../views/overlay');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Visitor');
const router = express.Router();

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function findAccount(email) {
  const cfg = config.load();
  return (cfg.accounts || []).find(a => a.email === email) || null;
}

function findParticipant(email) {
  const s = session.getState();
  return (s.participants || []).find(p => p.email === email) || null;
}

function activeProfile() {
  const s = session.getState();
  if (!s.sessionProfileId) return null;
  try { return session.getProfile(s.sessionProfileId); } catch { return null; }
}

function gauge(pct) {
  const r = 70, c = 2 * Math.PI * r;
  const cap = Math.max(0, Number(pct) || 0);
  const needle = Math.min(100, cap);
  const dash = (needle / 100) * c;
  const over = cap > 100;
  return `<svg id="gauge" viewBox="0 0 180 180" style="width:180px;height:180px">
    <circle cx="90" cy="90" r="${r}" stroke="#2a2f3a" stroke-width="20" fill="none"/>
    <circle id="gauge-fill" cx="90" cy="90" r="${r}" stroke="${over ? '#f0c674' : '#2a6df4'}" stroke-width="20" fill="none"
            stroke-dasharray="${dash.toFixed(1)} ${(c - dash).toFixed(1)}" stroke-linecap="round"
            transform="rotate(-90 90 90)" style="transition:stroke-dasharray 0.4s ease"/>
    <text id="gauge-pct" x="90" y="100" text-anchor="middle" font-size="38" font-weight="700" fill="${over ? '#f0c674' : 'currentColor'}">${cap.toFixed(0)}%</text>
  </svg>`;
}

function renderVisitorPage(req) {
  const email = req.user?.email || '';
  const cfg = config.load();
  const state = session.getState();
  const profile = activeProfile();
  const tplData = templatesSvc.load();
  const tpl = profile ? tplData.templateProfiles.find(p => p.id === profile.templateProfileId) : null;
  const actionsById = Object.fromEntries(tplData.actionTemplates.map(a => [a.id, a]));

  const account = findAccount(email);
  const nickname = account?.nickname || email.split('@')[0];

  const participant = findParticipant(email);
  const canConnect = !state.active || (participant && participant.canConnect !== false);
  const canControl = !!(state.active && participant && participant.canControl);
  // Dual-mode: paired T (canTarget=true) gets action authority too, even
  // without canControl. Non-target controllers only get authority when the
  // host has ticked "Allow visitor controllers in dual mode" on the profile.
  const isTargetUser = !!(state.active && participant && participant.canTarget === true);
  const dualMode = (state.mode === 'dual-target');
  const allowVisCtrl = dualMode ? !!state.allowVisitorControllersInDual : true;
  const hasActionAuthority = (canControl && allowVisCtrl) || (dualMode && isTargetUser);
  const chatEnabled = !!(profile && profile.settings?.chatroomEnabled);

  const minigamesList = minigames.list();
  const minigamesById = Object.fromEntries(minigamesList.map(mg => [mg.id, mg]));

  // Resolve active milestone — at ≥100% capacity, is100Plus milestone wins.
  let activeMilestone = null;
  if (state.active && tpl && tpl.milestones?.length) {
    if (state.capacity >= 100) {
      activeMilestone = tpl.milestones.find(m => m.is100Plus) || null;
    }
    if (!activeMilestone) {
      activeMilestone = tpl.milestones
        .filter(m => !m.is100Plus && state.capacity >= m.capacityMin && state.capacity <= m.capacityMax)
        .sort((a, b) => b.capacityMin - a.capacityMin)[0] || null;
    }
  }
  const milestoneActionIds = activeMilestone ? (activeMilestone.actionTemplateIds || []) : [];
  const alwaysActionIds = tpl?.defaultActionTemplateIds || [];
  const visibleActionIds = state.active
    ? Array.from(new Set([...milestoneActionIds, ...alwaysActionIds]))
    : [];
  const milestoneMinigameIds = activeMilestone ? (activeMilestone.minigameIds || []) : [];
  const alwaysMinigameIds = tpl?.defaultMinigameIds || [];
  const visibleMinigameIds = state.active
    ? Array.from(new Set([...milestoneMinigameIds, ...alwaysMinigameIds]))
    : [];

  const css = `
    :root {
      color-scheme: dark; font-size: 18px;
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
    body { margin: 0; font-family: system-ui, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; min-height: 100vh; display: flex; flex-direction: column; }
    .topbar { background: var(--bg-2); padding: 14px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .topbar h1 { margin: 0; font-size: 1.1rem; font-weight: 600; }
    .you { font-size: 0.85rem; color: var(--text-faint); }
    .theme-toggle { background: transparent; color: var(--text); border: 1px solid var(--border); border-radius: 999px; width: 36px; height: 36px; cursor: pointer; padding: 0; font-size: 0.95rem; }
    main { flex: 1; padding: 18px 16px 18px; max-width: 1100px; margin: 0 auto; width: 100%; }
    .card { background: var(--bg-2); border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin-bottom: 16px; }
    .pill { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 0.85rem; }
    .pill.ok { background: #133d2b; color: #6ddc9b; }
    .pill.warn { background: #4a3413; color: #f0c674; }
    .pill.bad { background: #4a1b1b; color: #f08484; }
    .action-btn { min-height: 56px; padding: 14px 18px; background: #2a6df4; color: #fff; border: 0; border-radius: 10px; font-size: 1rem; font-family: inherit; cursor: pointer; }
    .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .action-btn.running { background: #6ddc9b; color: #0f1115; }
    .action-cell { position: relative; display: flex; }
    .action-cell .action-btn { flex: 1; width: 100%; padding-right: 40px; }
    .action-help-btn { position: absolute; top: 6px; right: 6px; width: 28px; height: 28px; padding: 0; border-radius: 50%; background: rgba(0,0,0,0.45); color: #fff; border: 1px solid rgba(255,255,255,0.25); font-size: 0.9rem; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; font-family: inherit; }
    .action-help-btn:hover { background: rgba(0,0,0,0.75); }
    .help-modal-bg { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:2000; align-items:center; justify-content:center; padding:20px; }
    .help-modal-bg.open { display:flex; }
    .help-modal { background:var(--bg-2); border:1px solid var(--border); border-radius:14px; padding:24px; max-width:520px; width:100%; }
    .help-modal h3 { margin:0 0 12px; font-size:1.25rem; }
    .help-modal p { margin:0 0 18px; font-size:1.05rem; line-height:1.5; }
    .help-modal .help-close { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:12px 22px; font-size:1rem; cursor:pointer; min-width:120px; }
    .top-row { display: grid; grid-template-columns: 300px 1fr; gap: 16px; margin-bottom: 16px; align-items: stretch; }
    .top-row > .card { margin: 0; min-height: 360px; }
    .gauge-card { display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .pump-status { font-size: 1.1rem; font-weight: 600; margin: 10px 0 0; min-height: 1.5em; color: #e8e8e8; }
    .pump-status .pump-state { color: #6ddc9b; }
    .pump-status.idle .pump-state { color: #7a8597; }
    .pump-status .pump-count { color: #f0c674; margin-left: 4px; font-weight: 500; }
    .cycle-status { font-size: 0.95rem; color: #f0c674; margin: 2px 0 0; min-height: 1.1em; }
    .milestone-pane .milestone-title { font-size: 1.5rem; font-weight: 700; margin: 0 0 10px; }
    .milestone-pane .milestone-welcome { font-size: 1.05rem; line-height: 1.5; margin: 0 0 10px; color: var(--text); }
    .milestone-pane .milestone-announcement { font-size: 1.05rem; line-height: 1.5; margin: 0 0 18px; color: var(--text-muted); border-left: 3px solid var(--accent); padding: 4px 12px; background: var(--bg-3); border-radius: 0 8px 8px 0; }
    .milestone-pane .milestone-announcement:empty { display: none; }
    .milestone-pane .action-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
    .cam-grid { display: flex; justify-content: center; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; width: 100%; }
    .cam-slot { flex: 1 1 0; min-width: 0; max-width: min(85vh, 80vw); display: flex; flex-direction: column; gap: 10px; align-items: stretch; }
    .cam-slot:empty { display: none; }
    /* Host (owner) is the dominant tile. Controller slot — including the visitor's
       own webcam preview — is sized noticeably smaller. */
    #cam-owner-slot { flex: 2 1 0; max-width: min(85vh, 65vw); }
    #cam-controller-slot { flex: 1 1 0; max-width: min(40vh, 30vw); }
    .cam-tile { width: 100%; aspect-ratio: var(--cam-aspect, 1); background:var(--bg-3); border:1px solid var(--border); border-radius:14px; overflow:hidden; position:relative; }
    .cam-tile.local-cam-placeholder { display: flex; align-items: center; justify-content: center; padding: 14px; text-align: center; cursor: default; }
    .cam-tile.local-cam-placeholder .placeholder-btn { background: var(--accent); color: #fff; border: 0; padding: 12px 16px; border-radius: 10px; font-size: 0.95rem; cursor: pointer; font-family: inherit; }
    .cam-tile .local-ctrls { position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%); display: flex; gap: 6px; z-index: 6; }
    .cam-tile .local-ctrls button { background: rgba(0,0,0,0.65); color: #fff; border: 0; border-radius: 6px; padding: 6px 10px; font-size: 0.95rem; cursor: pointer; min-width: 36px; }
    .cam-tile .local-ctrls button.stop { background: rgba(161,48,48,0.85); }
    .cam-tile .local-ctrls button.muted { background: rgba(74,52,19,0.9); color: #f0c674; }
    .cam-tile video { width:100%; height:100%; object-fit:cover; }
    .cam-tile .rt-label { position:absolute; bottom:8px; left:10px; background:rgba(0,0,0,0.65); padding:4px 10px; border-radius:6px; font-size:0.9rem; }
    .cam-tile .rt-ctrls { position:absolute; top:8px; right:8px; display:flex; gap:6px; }
    .cam-tile .rt-ctrls button { background:rgba(0,0,0,0.6); border:0; color:#fff; border-radius:6px; padding:6px 10px; font-size:1rem; cursor:pointer; }
    .cam-tile.muted-video video { visibility: hidden; }
    /* ====== Dual-Target visitor layout ====== */
    .dual-cam-stack { display: flex; flex-direction: column; gap: 20px; margin-bottom: 14px; }
    .cam-pair { position: relative; width: 100%; }
    .cam-pair .cam-slot.wide { width: 100%; max-width: none; flex: none; }
    .cam-pair .cam-slot.wide .cam-tile { width: 100%; aspect-ratio: var(--cam-aspect, 16/9); }
    .cam-pair .gauge-float {
      position: absolute; right: -8px; top: 12px;
      background: rgba(15, 17, 21, 0.92);
      border: 1px solid var(--border); border-radius: 12px;
      padding: 8px 12px 10px;
      box-shadow: 0 4px 18px rgba(0,0,0,0.45);
      z-index: 5;
      display: flex; flex-direction: column; align-items: center; gap: 2px;
    }
    .cam-pair .gauge-float svg { width: 150px; height: 150px; }
    .cam-pair .gauge-float .gauge-name { font-weight: 600; font-size: 0.92rem; color: var(--text); margin-bottom: 2px; }
    .cam-pair .gauge-float .pump-status { font-size: 0.85rem; min-height: 1em; margin: 0; }
    .cam-pair .gauge-float .pump-status .pump-state { font-weight: 600; }
    .cam-pair .gauge-float .pump-status.idle .pump-state { color: var(--text-faint); }
    .milestone-pane.mini .milestone-title { font-size: 1.1rem; margin: 0 0 4px; }
    .milestone-pane.mini .milestone-welcome { font-size: 0.95rem; margin: 0 0 4px; }
    .milestone-pane.mini .milestone-announcement { font-size: 0.9rem; margin: 0 0 8px; padding: 3px 8px; }
    .ab-toggle { display: inline-flex; background: var(--bg-3); border: 1px solid var(--border); border-radius: 999px; padding: 3px; gap: 3px; margin: 0 0 10px; }
    .ab-toggle .ab-btn { background: transparent; color: var(--text-muted); border: 0; padding: 6px 14px; border-radius: 999px; cursor: pointer; font-weight: 600; font-size: 0.92rem; transition: background 0.12s ease, color 0.12s ease; line-height: 1.15; }
    .ab-toggle .ab-btn.active { background: var(--accent); color: #fff; }
    .ab-toggle .ab-btn:not(.active):hover { color: var(--text); }
    .ab-toggle .ab-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
    .dual-consent-bar { display: flex; gap: 14px; align-items: center; justify-content: center; flex-wrap: wrap; padding: 12px 16px; margin: 0 0 14px; border: 1px solid #b88dff; background: rgba(123, 63, 214, 0.12); border-radius: 12px; }
    .dual-consent-bar .status { font-size: 0.98rem; color: var(--text); }
    .dual-consent-bar .consent-btn { background: #2a8a6d; color: #fff; border: 0; border-radius: 999px; padding: 10px 26px; font-size: 1rem; font-weight: 700; cursor: pointer; }
    .dual-consent-bar .consent-btn:hover { background: #34a584; }
    .dual-consent-bar .muted { font-size: 0.9rem; color: var(--text-muted); }
    /* Sticky safety button on the target's own cam tile — bypasses the host
       and hits localhost satellite directly. Always available while paired. */
    .safety-stop-btn {
      position: absolute; left: 50%; bottom: 14px;
      transform: translateX(-50%);
      background: rgba(160, 35, 35, 0.92);
      color: #fff; border: 1px solid rgba(220, 70, 70, 0.7);
      border-radius: 999px; padding: 8px 18px;
      font-size: 0.95rem; font-weight: 700;
      cursor: pointer; z-index: 6;
      box-shadow: 0 4px 14px rgba(0,0,0,0.45);
    }
    .safety-stop-btn:hover { background: rgba(180, 45, 45, 0.95); }
    .safety-stop-btn:active { transform: translateX(-50%) scale(0.96); }
    @media (max-width: 900px) {
      .cam-pair .gauge-float {
        right: 8px; top: 8px;
        padding: 4px 6px 5px;
        background: rgba(15, 17, 21, 0.85);
        backdrop-filter: blur(4px);
      }
      .cam-pair .gauge-float svg { width: 84px; height: 84px; }
      .cam-pair .gauge-float .gauge-name { font-size: 0.75rem; }
      .cam-pair .gauge-float .pump-status { font-size: 0.75rem; }
    }
    .chat-row { display: grid; grid-template-columns: 1fr 220px; gap: 12px; }
    .chat-row > .card { margin: 0; display: flex; flex-direction: column; }
    /* Give the scrollable panes an explicit height (with scroll) so they DON'T
       collapse inside a flex column whose height is content-driven, and DON'T
       grow the page when content overflows. */
    .chat-pane .chat-log { height: 340px; max-height: 50vh; overflow-y: auto; background:var(--bg-3); border:1px solid var(--border); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:10px; }
    .chat-msg { word-wrap: break-word; overflow-wrap: anywhere; }
    .chat-msg img { max-width: 100%; height: auto; }
    .chat-pane .chat-input-row { margin-top: 10px; display: flex; gap: 8px; }
    .chat-pane .chat-input-row input { flex:1; min-height:48px; padding:12px 14px; background:var(--bg-3); color:var(--text); border:1px solid var(--border); border-radius:10px; font-size:1rem; font-family:inherit; }
    .chat-pane .chat-input-row button { min-height:48px; padding:0 22px; background:var(--accent); color:#fff; border:0; border-radius:10px; font-size:1rem; cursor:pointer; }
    .about-me-card { margin-top: 12px; padding: 12px 14px; background: var(--bg-3); border: 1px solid var(--border); border-radius: 10px; }
    .about-me-title { margin: 0 0 6px; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-faint); font-weight: 700; }
    .about-me-body { font-size: 0.95rem; line-height: 1.45; color: var(--text); white-space: pre-wrap; word-wrap: break-word; }
    .participants-pane .p-list { display: flex; flex-direction: column; gap: 4px; height: 340px; max-height: 50vh; overflow-y: auto; }
    .participants-pane .p-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; background:var(--bg-3); border:1px solid var(--border); border-radius:6px; font-size: 0.95rem; }
    .participants-pane .p-section-title { font-size: 0.78rem; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.08em; margin: 10px 0 4px; font-weight: 700; }
    .participants-pane .p-section-title:first-child { margin-top: 0; }
    .presence-dot { width: 8px; height: 8px; border-radius: 50%; background:#7a8597; flex-shrink:0; }
    .presence-dot.online { background:#6ddc9b; }
    .presence-dot.afk { background:#f0c674; }
    .p-item.afk { font-style: italic; opacity: 0.75; }
    @media (max-width: 760px) {
      .top-row { grid-template-columns: 1fr; }
      .chat-row { grid-template-columns: 1fr; }
      #cam-owner-slot { max-width: 100%; flex: 1 0 100%; }
      #cam-controller-slot { max-width: 55%; flex: 0 0 auto; align-self: center; }
      .milestone-pane .action-grid { grid-template-columns: 1fr 1fr; }
    }
    #session-stage { position: relative; }
    #standby-overlay { display:none; position:absolute; inset:0; background: rgba(15,17,21,0.85); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); z-index: 50; align-items: center; justify-content: center; border-radius: 12px; }
    #standby-overlay.active { display: flex; }
    .standby-text { font-size: clamp(2.5rem, 12vw, 6rem); font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase; color: #f0c674; text-shadow: 0 6px 40px rgba(0,0,0,0.6); text-align: center; padding: 0 20px; }
    .cam-tile.standby-blackout video,
    .cam-tile.peer-video-muted video { visibility: hidden; }
    .cam-tile.peer-video-muted::after { content: "VIDEO MUTED"; position:absolute; inset:0; background:#000; display:flex; align-items:center; justify-content:center; color:#555; font-weight:700; font-size:1.05rem; letter-spacing:0.15em; z-index:2; }
    .cam-tile.standby-blackout::after { content: "STANDBY"; position:absolute; inset:0; background:#000; display:flex; align-items:center; justify-content:center; color:#4a3413; font-weight:900; font-size:1.4rem; letter-spacing:0.2em; z-index:3; }
    .cam-tile .audio-muted-badge { display: none; position: absolute; bottom: 10px; right: 10px; background: rgba(0,0,0,0.7); border-radius: 50%; width: 30px; height: 30px; align-items: center; justify-content: center; font-size: 0.95rem; z-index: 5; }
    .cam-tile.peer-audio-muted .audio-muted-badge { display: flex; }
    ${overlayCss()}
  `;

  const themeBootstrap = `<script>(function(){try{var t=localStorage.getItem('pd-theme')||'dark';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>`;
  const themeToggleJs = `
    function toggleTheme() {
      var cur = document.documentElement.getAttribute('data-theme') || 'dark';
      var next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('pd-theme', next); } catch(e) {}
      var btn = document.getElementById('theme-toggle');
      if (btn) btn.textContent = next === 'dark' ? '🌙' : '☀️';
    }
    (function(){
      var cur = document.documentElement.getAttribute('data-theme') || 'dark';
      var btn = document.getElementById('theme-toggle');
      if (btn) btn.textContent = cur === 'dark' ? '🌙' : '☀️';
    })();
  `;
  const themeToggleBtn = `<button id="theme-toggle" class="theme-toggle" onclick="toggleTheme()" title="toggle light/dark">🌙</button>`;

  if (!canConnect) {
    return `<!doctype html><html lang="en" data-theme="dark"><head>
      ${themeBootstrap}
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>PumpDirect</title><style>${css}</style></head>
      <body>
        <div class="topbar">
          <h1>PumpDirect</h1>
          <div style="display:flex;gap:10px;align-items:center">
            <span class="you">${escapeHtml(nickname)}</span>
            ${themeToggleBtn}
          </div>
        </div>
        <main><div class="card"><h2>Not on the participant list</h2>
        <p style="font-size:1.05rem">Hi <strong>${escapeHtml(nickname)}</strong>. You're on the owner's account allowlist but haven't been added to the active session.</p>
        </div></main>
        <script>${themeToggleJs}</script>
      </body></html>`;
  }

  if (!state.active) {
    return `<!doctype html><html lang="en" data-theme="dark"><head>
      ${themeBootstrap}
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
      <title>PumpDirect</title>
      <style>
        ${css}
        body { display:flex; align-items:center; justify-content:center; }
        .splash { text-align:center; padding:40px 24px; max-width:520px; }
        .splash h1 { font-size:2rem; margin:0 0 18px; }
        .splash .welcome { font-size:1.1rem; color:var(--text-muted); line-height:1.5; margin:18px 0 0; }
        .splash .dot { display:inline-block; width:10px; height:10px; border-radius:50%; background:var(--text-faint); margin-right:8px; vertical-align:middle; animation:pulse 2s infinite; }
        @keyframes pulse { 0%,100%{opacity:0.4} 50%{opacity:1} }
      </style></head>
      <body>
        <div class="topbar" style="position:absolute;top:0;left:0;right:0">
          <h1>PumpDirect</h1>
          <div style="display:flex;gap:10px;align-items:center">
            <span class="you">${escapeHtml(nickname)}</span>
            ${themeToggleBtn}
          </div>
        </div>
        <div class="splash">
          <h1><span class="dot"></span>No active session</h1>
          <p style="color:var(--text-muted)">The owner hasn't started a session yet. This page will refresh automatically when one begins.</p>
        </div>
        <script>
          ${themeToggleJs}
          // Reload as soon as the session goes live.
          function connect() {
            const proto = location.protocol === 'https:' ? 'wss' : 'ws';
            const ws = new WebSocket(proto + '://' + location.host + '/ws/visitor');
            ws.onmessage = (e) => {
              const m = JSON.parse(e.data);
              if (m.type === 'state' && m.state && m.state.active) location.reload();
            };
            ws.onclose = () => setTimeout(connect, 1500);
          }
          connect();
        </script>
      </body></html>`;
  }

  const isRunningV = !!state.currentActionTemplateId;
  const introGatedV = !!state.introPending;
  const lockBtnsV = isRunningV || introGatedV;
  const alwaysBtns = (state.active && hasActionAuthority) ? `
    <button class="action-btn pump-toggle" onclick="vPumpToggle()" style="background:${isRunningV ? '#a13030' : '#1a8a4d'};color:#fff" ${introGatedV ? 'disabled' : ''}>${isRunningV ? '⏻ Pump Off' : '⏵ Pump On'}</button>
    <button class="action-btn misc-action-btn" onclick="vTimed()" style="background:#1a8a4d;color:#fff" ${lockBtnsV ? 'disabled' : ''}>⏱ Timed</button>
    <button class="action-btn misc-action-btn" onclick="vCycle()" style="background:#1a8a4d;color:#fff" ${lockBtnsV ? 'disabled' : ''}>↻ Cycle</button>
  ` : '';
  const actionCellsV = visibleActionIds.map(id => {
    const a = actionsById[id];
    return `<div class="action-cell">
      <button class="action-btn" data-action-id="${escapeHtml(id)}" onclick="vFire('${escapeHtml(id)}')" ${introGatedV ? 'disabled' : ''}>${escapeHtml(a?.name || '?')}</button>
      <button class="action-help-btn" type="button" title="What does this do?" onclick="vActionHelp('${escapeHtml(id)}')">?</button>
    </div>`;
  }).join('');
  const minigameCellsV = visibleMinigameIds.map(id => {
    const mg = minigamesById[id]; if (!mg) return '';
    return `<div class="action-cell">
      <button class="action-btn minigame-btn" data-minigame-id="${escapeHtml(id)}" onclick="vOpenMinigame('${escapeHtml(id)}')" style="background:${escapeHtml(mg.color)};color:#fff" ${introGatedV ? 'disabled' : ''}>🎲 ${escapeHtml(mg.name)}</button>
      <button class="action-help-btn" type="button" title="What does this do?" onclick="vMinigameHelp('${escapeHtml(id)}')">?</button>
    </div>`;
  }).join('');
  const hasAnyV = visibleActionIds.length || visibleMinigameIds.length;
  const introNote = '<p id="v-intro-lock-note" class="muted" style="color:#f0c674;font-size:0.95rem;margin:0 0 8px;display:' + (introGatedV ? 'block' : 'none') + '">Host is presenting an intro — pump controls unlock when it finishes.</p>';
  // A/B toggle (dual mode + has action authority). Nicknames come from accounts.
  const abTargetNick = (() => {
    if (!dualMode) return '';
    const t = (state.participants || []).find(p => p.canTarget === true);
    if (!t) return 'Waiting…';
    const a = config.load().accounts.find(x => x.email === t.email);
    return a?.nickname || t.email.split('@')[0];
  })();
  const abHostNick = ownerDisplayName || 'Host';
  const abToggle = (dualMode && hasActionAuthority) ? `
    <div class="ab-toggle" id="ab-toggle" role="group" aria-label="Pump target">
      <button type="button" class="ab-btn ab-host active" data-ab="host" onclick="_setAbTarget('host')">🔵 ${escapeHtml(abHostNick)}</button>
      <button type="button" class="ab-btn ab-target" data-ab="target" onclick="_setAbTarget('target')" id="ab-btn-target">⚪ <span id="ab-target-label">${escapeHtml(abTargetNick)}</span></button>
    </div>` : '';
  const actionGrid = !state.active
    ? '<p class="muted" style="color:#7a8597">No active session.</p>'
    : !hasActionAuthority
      ? '<p class="muted" style="color:#7a8597">You can watch + chat, but the owner has not enabled device control for you.</p>'
      : introNote + abToggle + `<div class="action-grid">${alwaysBtns}${hasAnyV
          ? actionCellsV + minigameCellsV
          : '<p class="muted" style="color:#7a8597;grid-column:1/-1">No template actions or minigames at this capacity — Pump On / Timed / Cycle still work.</p>'}</div>`;

  // Participant list — client-rendered from live state so presence (connected / AFK)
  // can update without a reload. Owner-as-Host is always shown; everyone else only
  // shows up while their WS is open (connected or AFK).
  const ownerEmailCfg = cfg.cloudflare?.ownerEmail || '';
  // Visitors see the owner's public-facing display name. Fall back to the account
  // nickname, then the email prefix, then a generic label only as last resort.
  const ownerDisplayName = (cfg.owner?.displayName || '').trim()
    || (cfg.accounts || []).find(a => a.email === ownerEmailCfg)?.nickname
    || (ownerEmailCfg ? ownerEmailCfg.split('@')[0] : 'owner');
  const ownerNick = ownerDisplayName;
  const nicknamesByEmail = Object.fromEntries((cfg.accounts || []).map(a => [a.email, a.nickname || a.email.split('@')[0]]));
  // Owner entry in the lookup map uses the public display name, matching what
  // visitors see in the Host row and on the owner's cam tile.
  if (ownerEmailCfg) nicknamesByEmail[ownerEmailCfg] = ownerDisplayName;

  return `<!doctype html><html lang="en" data-theme="dark"><head>
    ${themeBootstrap}
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <title>PumpDirect${profile ? ' — ' + escapeHtml(profile.name) : ''}</title><style>${css}</style>
  </head><body>
    <div class="topbar">
      <h1>PumpDirect</h1>
      <div style="display:flex;gap:10px;align-items:center">
        <span class="you">${escapeHtml(nickname)}</span>
        ${themeToggleBtn}
      </div>
    </div>
    <main>
      <div id="session-stage" data-mode="${escapeHtml(profile?.mode || 'single-target')}">
        <div id="standby-overlay"><div class="standby-text">Please Stand By</div></div>
      ${profile?.mode === 'dual-target' ? `
        ${state.active && !((() => {
          const t = (state.participants || []).find(p => p.canTarget === true);
          return state.hostStartAccepted && state.targetStartAccepted && !!t;
        })()) ? `
          <div id="v-consent-bar" class="dual-consent-bar">
            ${(() => {
              const t = (state.participants || []).find(p => p.canTarget === true);
              if (!t) return '<span class="status">⏳ Waiting for a target to pair…</span>';
              if (!state.hostStartAccepted && !state.targetStartAccepted) return '<span class="status">🤝 Both parties must confirm to begin</span>';
              if (!state.hostStartAccepted) return '<span class="status">⏳ Waiting for host to confirm…</span>';
              if (!state.targetStartAccepted) return isTargetUser
                ? '<span class="status">🤝 Your turn — confirm to begin</span>'
                : '<span class="status">⏳ Waiting for target to confirm…</span>';
              return '';
            })()}
            ${isTargetUser && !state.targetStartAccepted ? `<button onclick="vConfirmStart()" class="consent-btn">✓ Confirm Start</button>` : ''}
            ${isTargetUser && state.targetStartAccepted && !state.hostStartAccepted ? '<span class="muted">✓ You confirmed</span>' : ''}
          </div>` : ''}
        <!-- ====== DUAL-TARGET VISITOR LAYOUT ====== -->
        <div class="dual-cam-stack">
          <div class="cam-pair">
            <div class="cam-slot wide" id="cam-owner-slot"></div>
            <div class="gauge-float gauge-host">
              <div class="gauge-name">🔵 ${escapeHtml(ownerDisplayName)}</div>
              ${gauge(state.capacity)}
              <p class="pump-status ${state.pumpOn ? '' : 'idle'}" id="pump-status" style="margin:2px 0 0">
                <span class="pump-state">${state.pumpOn ? 'Running' : 'Idle'}</span><span class="pump-count" id="pump-count"></span>
              </p>
              <p class="cycle-status" id="cycle-status" style="margin:2px 0 0"></p>
            </div>
          </div>
          <div class="cam-pair">
            <div class="cam-slot wide" id="cam-controller-slot"></div>
            <div class="gauge-float gauge-target" id="gauge-target">
              <div class="gauge-name">⚪ <span id="target-nickname">${(() => {
                const t = (state.participants || []).find(p => p.canTarget === true);
                const acct = t ? config.load().accounts.find(a => a.email === t.email) : null;
                return escapeHtml(acct?.nickname || (t ? t.email.split('@')[0] : 'Waiting…'));
              })()}</span></div>
              ${gauge(state.targetState?.capacity || 0)}
              <p class="pump-status ${state.targetState?.pumpOn ? '' : 'idle'}" id="target-pump-status" style="margin:2px 0 0">
                <span class="pump-state">${state.targetState?.pumpOn ? 'Running' : 'Idle'}</span>
              </p>
            </div>
            ${isTargetUser ? `
              <button id="v-safety-stop" class="safety-stop-btn" onclick="vStopMyPump()" title="Force-stop your local pump (bypasses host)">
                ⏹ Stop my pump
              </button>` : ''}
          </div>
        </div>
        <div class="card milestone-pane mini">
          <p class="milestone-welcome">${escapeHtml(profile?.welcomeMessage || '')}</p>
          <p class="milestone-title">${activeMilestone ? escapeHtml(activeMilestone.name) : (state.active ? escapeHtml(tpl?.name || 'Default') : 'Idle')}</p>
          <p class="milestone-announcement">${activeMilestone ? escapeHtml(activeMilestone.announcement || '') : ''}</p>
          ${actionGrid}
        </div>
        <div id="trigger-fx-stage"></div>
        <div id="action-flash-stage"></div>
      ` : `
        <!-- ====== SINGLE-TARGET VISITOR LAYOUT (unchanged) ====== -->
        <div class="top-row">
          <div class="card gauge-card">
            <h3 style="margin:0 0 4px;font-size:1.15rem;text-align:center">Inflation Capacity</h3>
            <p class="muted" style="margin:0 0 10px;font-size:0.85rem;text-align:center;line-height:1.35">Real, calibrated and calculated display of <strong>${escapeHtml(ownerDisplayName)}</strong>'s current fullness.</p>
            ${gauge(state.capacity)}
            <p class="pump-status ${state.pumpOn ? '' : 'idle'}" id="pump-status">
              Pump: <span class="pump-state">${state.pumpOn ? 'Running' : 'Idle'}</span><span class="pump-count" id="pump-count"></span>
            </p>
            <p class="cycle-status" id="cycle-status"></p>
          </div>
          <div class="card milestone-pane">
            <p class="milestone-welcome">${escapeHtml(profile?.welcomeMessage || '')}</p>
            <p class="milestone-title">${activeMilestone ? escapeHtml(activeMilestone.name) : (state.active ? escapeHtml(tpl?.name || 'Default') : 'Idle')}</p>
            <p class="milestone-announcement">${activeMilestone ? escapeHtml(activeMilestone.announcement || '') : ''}</p>
            ${actionGrid}
          </div>
        </div>

        <div class="cam-grid">
          <div class="cam-slot" id="cam-controller-slot"></div>
          <div class="cam-slot" id="cam-owner-slot"></div>
          <div id="trigger-fx-stage"></div>
          <div id="action-flash-stage"></div>
        </div>
      `}
      <div id="overlay-stage"></div>
      <div id="countdown-stage"></div>
      </div><!-- /session-stage -->

      <div class="chat-row">
        <div class="card chat-pane">
          <h3 style="margin:0 0 10px;font-size:1.05rem;display:flex;align-items:center;gap:8px">
            <span>Chat${chatEnabled ? '' : ' <span class="muted" style="font-size:0.9rem;font-weight:normal">(disabled)</span>'}</span>
            <span id="chat-presence-line" class="muted" style="margin-left:auto;font-size:0.82rem;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px"></span>
          </h3>
          <div id="chat-log" class="chat-log"></div>
          ${chatEnabled ? `
            <div class="chat-input-row">
              <input id="chat-input" type="text" placeholder="say something…" autocomplete="off" enterkeyhint="send" onkeydown="if(event.key==='Enter') vSend()">
              <button onclick="vSend()">Send</button>
            </div>` : ''}
          ${profile?.aboutMe ? `
            <div class="about-me-card" id="about-me-card">
              <h4 class="about-me-title">About me / Rules</h4>
              <div class="about-me-body">${escapeHtml(profile.aboutMe).replace(/\n/g, '<br>')}</div>
            </div>` : ''}
        </div>
        <div class="card participants-pane">
          <h3 style="margin:0 0 10px;font-size:1.05rem">Participants</h3>
          <div class="p-list" id="p-list"></div>
        </div>
      </div>
    </main>

    <!-- Dice Roll config modal — number of dice + result mode. -->
    <div id="dice-config-bg" class="help-modal-bg" onclick="vCloseDiceRoll(event)">
      <div class="help-modal" onclick="event.stopPropagation()">
        <h3>🎲 Dice Roll</h3>
        <p style="margin:0 0 14px">Roll d6 dice. The total pips drive the pump.</p>
        <p style="margin:0 0 12px"><label>Number of dice (1–6): <input id="dc-count" type="number" min="1" max="6" value="2" style="width:80px;font-size:1rem;padding:6px 8px"></label></p>
        <p style="margin:0 0 14px"><label style="display:block;margin-bottom:6px;font-weight:600">Result mode</label>
          <label style="display:block;padding:6px 0"><input type="radio" name="dc-mode" value="continuous" checked> Continuous — pump on for <em>total pips</em> seconds</label>
          <label style="display:block;padding:6px 0"><input type="radio" name="dc-mode" value="cycle"> Cycle — <em>total pips</em> × (1 sec on / 1 sec off)</label>
        </p>
        <p style="text-align:right;margin:0;display:flex;gap:8px;justify-content:flex-end">
          <button class="dice-close help-close" onclick="vCloseDiceRoll()" style="background:var(--bg-3);color:var(--text)">Cancel</button>
          <button class="help-close" onclick="vSubmitDiceRoll()" style="background:#7b3fd6">Roll</button>
        </p>
      </div>
    </div>

    <!-- Action help modal (shown when ? next to an action button is tapped). -->
    <div id="help-modal-bg" class="help-modal-bg" onclick="vHelpClose(event)">
      <div class="help-modal" onclick="event.stopPropagation()">
        <h3 id="help-title">Action</h3>
        <p id="help-body">…</p>
        <p style="text-align:right;margin:0"><button class="help-close" onclick="vHelpClose()">Close</button></p>
      </div>
    </div>

    <!-- Age-confirmation gate. Sessions only count once the owner runs them, so
         this fires only when state.active is true. Stored in sessionStorage so it
         appears once per browser session, not on every page reload. -->
    <div id="age-gate" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:9999;align-items:center;justify-content:center;padding:24px">
      <div style="max-width:520px;background:#161922;border:1px solid #f0c674;border-radius:14px;padding:30px;text-align:center">
        <h1 style="font-size:1.6rem;margin:0 0 14px;color:#f0c674">Age confirmation required</h1>
        <p style="font-size:1.05rem;line-height:1.5;margin:0 0 18px">
          By continuing, you confirm that you are <strong>at least 18 years of age, or 21 if the law in your jurisdiction requires it</strong> to engage with this content.
        </p>
        <p style="font-size:0.95rem;color:#9aa4b2;margin:0 0 22px">
          The owner of this instance is responsible for verifying participant ages and consent. If you are not of legal age, leave this page now.
        </p>
        <p style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin:0">
          <button onclick="vAgeConfirm()" class="action-btn">I am of legal age — continue</button>
          <button onclick="vAgeDecline()" style="background:#4a1b1b">Leave</button>
        </p>
      </div>
    </div>

    <script src="/assets/vendor/lottie.min.js"></script>
    <script>
      ${rtcClientJs({ myEmail: email })}
      ${chatCryptoJs()}
      ${overlayJs()}
    </script>
    <script>
      ${themeToggleJs}
      const CAN_CONTROL = ${JSON.stringify(canControl)};
      const CHAT_ENABLED = ${JSON.stringify(chatEnabled)};
      const NICKNAME = ${JSON.stringify(nickname)};
      const MY_EMAIL = ${JSON.stringify(email)};
      // Globals consumed by views/overlay.js for Spin-button visibility + the
      // POST endpoint when the trigger visitor confirms the spin.
      window.__MY_EMAIL = MY_EMAIL;
      // Host (owner) tile lives at id="rt-<sanitized owner email>" once their
      // stream connects via WebRTC. Use the same css-id sanitizer the rtc code
      // uses so the lookup matches.
      window.__textOverlayTarget = () => {
        if (!OWNER_EMAIL) return null;
        const safe = String(OWNER_EMAIL).replace(/[^a-z0-9_-]/gi, '_');
        return document.getElementById('rt-' + safe);
      };
      const OWNER_EMAIL = ${JSON.stringify(ownerEmailCfg)};
      const OWNER_NICK = ${JSON.stringify(ownerNick)};
      const NICKS = ${JSON.stringify(nicknamesByEmail)};
      const ACTIONS_INFO = ${JSON.stringify(Object.fromEntries(tplData.actionTemplates.map(a => [a.id, { name: a.name, description: a.description || '' }])))};
      const MINIGAMES_INFO = ${JSON.stringify(Object.fromEntries(minigamesList.map(m => [m.id, { name: m.name, kind: m.kind, color: m.color, description: m.description || '' }])))};
      const MILESTONES_BY_ID = ${JSON.stringify(Object.fromEntries((tpl?.milestones || []).map(m => [m.id, { name: m.name, announcement: m.announcement || '', actionTemplateIds: m.actionTemplateIds || [], minigameIds: m.minigameIds || [], minigameConfig: m.minigameConfig || {}, capacityMin: m.capacityMin, capacityMax: m.capacityMax, is100Plus: !!m.is100Plus }])))};
      const ALWAYS_ACTION_IDS = ${JSON.stringify(tpl?.defaultActionTemplateIds || [])};
      const ALWAYS_MINIGAME_IDS = ${JSON.stringify(tpl?.defaultMinigameIds || [])};
      const ALWAYS_MINIGAME_CONFIG = ${JSON.stringify(tpl?.defaultMinigameConfig || {})};
      const WHEELS_BY_ID = ${JSON.stringify(Object.fromEntries((tplData.wheelTemplates || []).map(w => [w.id, { name: w.name, sectionCount: (w.sections || []).length }])))};
      function _mergedWheelIdsForActive() {
        const m = _activeMilestone((window.__lastVisitorState && window.__lastVisitorState.capacity) || 0, !!(window.__lastVisitorState && window.__lastVisitorState.active));
        const ms = m ? (m.minigameConfig?.['prize-wheel']?.wheelIds || []) : [];
        const al = ALWAYS_MINIGAME_CONFIG['prize-wheel']?.wheelIds || [];
        return Array.from(new Set([...ms, ...al]));
      }
      const TPL_NAME = ${JSON.stringify(tpl?.name || 'Default')};
      const WELCOME_MSG = ${JSON.stringify(profile?.welcomeMessage || '')};
      let __lastRenderedMilestoneId = '__init__';
      function _safeAttr(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
      function _activeMilestone(capacity, active) {
        if (!active) return null;
        const ms = Object.entries(MILESTONES_BY_ID).map(([id, m]) => ({ id, ...m }));
        if (capacity >= 100) { const top = ms.find(m => m.is100Plus); if (top) return top; }
        const cands = ms.filter(m => !m.is100Plus && capacity >= m.capacityMin && capacity <= m.capacityMax)
                        .sort((a, b) => b.capacityMin - a.capacityMin);
        return cands[0] || null;
      }
      function renderMilestonePane(s) {
        // Re-render the milestone-pane (title + announcement + action grid) when the
        // active milestone changes. Computed client-side from capacity so this stays
        // in sync even before the server's first capacity-tick of a new session.
        const m = _activeMilestone(s.capacity || 0, !!s.active);
        const mid = m ? m.id : (s.active ? '__no_milestone__' : '__idle__');
        if (__lastRenderedMilestoneId === mid) return;
        __lastRenderedMilestoneId = mid;
        const titleEl = document.querySelector('.milestone-pane .milestone-title');
        const wmEl = document.querySelector('.milestone-pane .milestone-welcome');
        const annEl = document.querySelector('.milestone-pane .milestone-announcement');
        if (titleEl) titleEl.textContent = m ? m.name : (s.active ? TPL_NAME : 'Idle');
        if (wmEl) wmEl.textContent = WELCOME_MSG || '';
        // Milestone announcement sits beneath the welcome line — appears once a
        // milestone is entered and stays for the duration of that milestone.
        if (annEl) annEl.textContent = (s.active && m && m.announcement) ? m.announcement : '';
        const grid = document.querySelector('.milestone-pane .action-grid');
        if (!grid || !CAN_CONTROL || !s.active) return;
        const ids = Array.from(new Set([...((m && m.actionTemplateIds) || []), ...ALWAYS_ACTION_IDS]));
        const running = !!s.currentActionTemplateId;
        const alwaysBtns =
          '<button class="action-btn pump-toggle" onclick="vPumpToggle()" style="background:' + (running ? '#a13030' : '#1a8a4d') + ';color:#fff">' + (running ? '⏻ Pump Off' : '⏵ Pump On') + '</button>'
        + '<button class="action-btn misc-action-btn" onclick="vTimed()" style="background:#1a8a4d;color:#fff"' + (running ? ' disabled' : '') + '>⏱ Timed</button>'
        + '<button class="action-btn misc-action-btn" onclick="vCycle()" style="background:#1a8a4d;color:#fff"' + (running ? ' disabled' : '') + '>↻ Cycle</button>';
        const actionCells = ids.map(id => {
          const a = ACTIONS_INFO[id];
          return '<div class="action-cell">'
            + '<button class="action-btn" data-action-id="' + _safeAttr(id) + '" onclick="vFire(\\'' + _safeAttr(id) + '\\')">' + _safeAttr(a && a.name || '?') + '</button>'
            + '<button class="action-help-btn" type="button" title="What does this do?" onclick="vActionHelp(\\'' + _safeAttr(id) + '\\')">?</button>'
          + '</div>';
        }).join('');
        const mgIds = Array.from(new Set([...((m && m.minigameIds) || []), ...ALWAYS_MINIGAME_IDS]));
        const mgCells = mgIds.map(id => {
          const mg = MINIGAMES_INFO[id]; if (!mg) return '';
          return '<div class="action-cell">'
            + '<button class="action-btn minigame-btn" data-minigame-id="' + _safeAttr(id) + '" onclick="vOpenMinigame(\\'' + _safeAttr(id) + '\\')" style="background:' + _safeAttr(mg.color) + ';color:#fff">🎲 ' + _safeAttr(mg.name) + '</button>'
            + '<button class="action-help-btn" type="button" title="What does this do?" onclick="vMinigameHelp(\\'' + _safeAttr(id) + '\\')">?</button>'
          + '</div>';
        }).join('');
        grid.innerHTML = alwaysBtns + (actionCells || mgCells
          ? actionCells + mgCells
          : '<p class="muted" style="color:#7a8597;grid-column:1/-1">No template actions or minigames at this capacity — Pump On / Timed / Cycle still work.</p>');
      }
      function vMinigameHelp(id) {
        const mg = MINIGAMES_INFO[id]; if (!mg) return;
        document.getElementById('help-title').textContent = mg.name;
        document.getElementById('help-body').textContent = mg.description || 'No description set for this minigame.';
        document.getElementById('help-modal-bg').classList.add('open');
      }
      function vOpenMinigame(id) {
        const mg = MINIGAMES_INFO[id]; if (!mg) return;
        if (mg.kind === 'dice-roll') return vOpenDiceRoll();
        if (mg.kind === 'prize-wheel') return vOpenPrizeWheel();
        alert('Unsupported minigame: ' + mg.name);
      }
      async function vOpenPrizeWheel() {
        // Server-side random pick from the merged candidate list — the spinner
        // never sees a picker, the wheel just appears.
        const ids = _mergedWheelIdsForActive().filter(id => WHEELS_BY_ID[id]);
        if (!ids.length) return alert('No wheels assigned to this button yet.');
        const r = await fetch('/api/visitor/minigame/prize-wheel', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ wheelIds: ids }) });
        if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || 'failed'); }
      }
      function vOpenDiceRoll() {
        document.getElementById('dice-config-bg').classList.add('open');
      }
      function vCloseDiceRoll(e) {
        if (e && e.target && e.target.id !== 'dice-config-bg' && !e.target.classList.contains('dice-close')) return;
        document.getElementById('dice-config-bg').classList.remove('open');
      }
      async function vSubmitDiceRoll() {
        const count = parseInt(document.getElementById('dc-count').value, 10);
        const mode = (document.querySelector('input[name="dc-mode"]:checked') || {}).value || 'continuous';
        const r = await fetch('/api/visitor/minigame/dice-roll', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ count, mode }) });
        if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || 'failed'); return; }
        document.getElementById('dice-config-bg').classList.remove('open');
      }
      function _nickFor(e) { return NICKS[e] || (e || '').split('@')[0] || e; }
      function _partRow(p, isMe, viewerIsController) {
        const nick = _nickFor(p.email);
        const dotCls = p.presence === 'afk' ? 'afk' : (p.presence === 'connected' ? 'online' : '');
        const itemCls = p.presence === 'afk' ? ' afk' : '';
        const meTag = isMe ? ' <span class="muted" style="font-size:0.8rem;font-style:normal">(you)</span>' : '';
        const afkTag = p.presence === 'afk' ? ' <span class="muted" style="font-size:0.8rem;font-style:normal">· afk</span>' : '';
        // A current controller can click a voyeur's row to hand off control.
        // Server enforces the same conditions; this just gates the affordance.
        const clickable = viewerIsController && !p.canControl && !isMe;
        const click = clickable ? ' onclick="vPassControl(\\'' + p.email.replace(/'/g, '\\\\\\'') + '\\')" style="cursor:pointer" title="Pass control to ' + escapeHtml(nick) + '"' : '';
        return '<div class="p-item' + itemCls + '"' + click + '><span class="presence-dot ' + dotCls + '"></span><span>' + escapeHtml(nick) + meTag + afkTag + (clickable ? ' <span class="muted" style="font-size:0.78rem;font-style:normal">· tap to pass control</span>' : '') + '</span></div>';
      }
      function renderParticipants(s) {
        const list = document.getElementById('p-list');
        if (!list) return;
        const ownerPresence = s.ownerPresence || null;
        const me = (s.participants || []).find(p => p.email === MY_EMAIL);
        const viewerIsController = !!(me && me.canControl);
        const ownerHtml = '<div class="p-item' + (ownerPresence === 'afk' ? ' afk' : '') + '">'
          + '<span class="presence-dot ' + (ownerPresence === 'afk' ? 'afk' : ownerPresence === 'connected' ? 'online' : '') + '"></span>'
          + '<span>' + escapeHtml(OWNER_NICK) + (MY_EMAIL === OWNER_EMAIL ? ' <span class="muted" style="font-size:0.8rem;font-style:normal">(you)</span>' : '')
          + (ownerPresence === 'afk' ? ' <span class="muted" style="font-size:0.8rem;font-style:normal">· afk</span>' : '')
          + '</span></div>';
        // Only visitors actually in the session (presence set) are shown to other visitors.
        const present = (s.participants || []).filter(p => p.email !== OWNER_EMAIL && p.presence);
        const controllers = present.filter(p => p.canControl);
        const voyeurs = present.filter(p => !p.canControl);
        let out = '<div class="p-section-title">Host</div>' + ownerHtml;
        if (controllers.length) out += '<div class="p-section-title">Controllers</div>' + controllers.map(p => _partRow(p, p.email === MY_EMAIL, viewerIsController)).join('');
        if (voyeurs.length)     out += '<div class="p-section-title">Voyeurs</div>'     + voyeurs.map(p => _partRow(p, p.email === MY_EMAIL, viewerIsController)).join('');
        if (!controllers.length && !voyeurs.length) {
          out += '<p class="muted" style="font-size:0.9rem;margin:8px 0 0">No other visitors connected.</p>';
        }
        list.innerHTML = out;
      }
      async function vPassControl(targetEmail) {
        const nick = _nickFor(targetEmail);
        if (!confirm('Pass control to ' + nick + '? You will become a voyeur; they get control with video disabled.')) return;
        const r = await fetch('/api/visitor/pass-control', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ to: targetEmail }) });
        if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || 'failed'); }
      }
      function vActionHelp(id) {
        const a = ACTIONS_INFO[id];
        if (!a) return;
        document.getElementById('help-title').textContent = a.name;
        document.getElementById('help-body').textContent = a.description || 'No description has been set for this action yet.';
        document.getElementById('help-modal-bg').classList.add('open');
      }
      function vHelpClose(e) {
        if (e && e.target && e.target.id !== 'help-modal-bg' && !e.target.classList.contains('help-close')) return;
        document.getElementById('help-modal-bg').classList.remove('open');
      }
      // Show age gate every time the owner starts a NEW session. The accept
      // flag is keyed by the session's startedAt so a fresh session forces a
      // fresh consent — previously the flag was global and persisted for the
      // whole browser tab, so visitors only saw the gate once.
      const __AGE_KEY = 'pd_age_ok_' + (${JSON.stringify(state.startedAt || '')} || '_init');
      if (!sessionStorage.getItem(__AGE_KEY)) {
        document.getElementById('age-gate').style.display = 'flex';
      }
      function vAgeConfirm() {
        sessionStorage.setItem(__AGE_KEY, '1');
        document.getElementById('age-gate').style.display = 'none';
      }
      function vAgeDecline() {
        window.location.href = 'about:blank';
      }
      let wsSig = null;
      function cssId(s) { return String(s).replace(/[^a-z0-9_-]/gi, '_'); }
      function attachRemoteTile(email, stream, nickname, isOwner) {
        const label = nickname || email;
        let tile = document.getElementById('rt-' + cssId(email));
        if (!tile) {
          tile = document.createElement('div');
          tile.id = 'rt-' + cssId(email);
          tile.className = 'cam-tile';
          tile.innerHTML =
            '<video autoplay playsinline></video>' +
            '<div class="rt-label"></div>' +
            '<div class="rt-ctrls">' +
              '<button data-act="hide">👁</button>' +
              '<button data-act="mute">🔊</button>' +
            '</div>' +
            '<div class="audio-muted-badge" title="audio muted by publisher">🔇</div>';
          const slot = isOwner
            ? document.getElementById('cam-owner-slot')
            : document.getElementById('cam-controller-slot');
          slot.appendChild(tile);
          const v = tile.querySelector('video');
          const hideBtn = tile.querySelector('button[data-act="hide"]');
          const muteBtn = tile.querySelector('button[data-act="mute"]');
          hideBtn.onclick = () => { const hidden = tile.classList.toggle('muted-video'); hideBtn.textContent = hidden ? '🚫' : '👁'; };
          muteBtn.onclick = () => { v.muted = !v.muted; muteBtn.textContent = v.muted ? '🔇' : '🔊'; };
        }
        tile.querySelector('.rt-label').textContent = label;
        const v = tile.querySelector('video');
        v.srcObject = stream;
        v.onloadedmetadata = () => {
          // Remote streams: owner can be any aspect, controllers are forced 1:1 at the source.
          if (v.videoWidth > 0 && v.videoHeight > 0) {
            tile.style.setProperty('--cam-aspect', (v.videoWidth / v.videoHeight).toFixed(4));
          }
        };
        const ps = __peerTrackState.get(email);
        if (ps) {
          tile.classList.toggle('peer-video-muted', !!ps.videoMuted);
          tile.classList.toggle('peer-audio-muted', !!ps.audioMuted);
        }
        // Host's tile may have just been created — re-hang any active text overlays.
        if (isOwner) renderTextOverlays(window.__lastVisitorState);
      }
      function removeRemoteTile(email) {
        const tile = document.getElementById('rt-' + cssId(email));
        if (tile) {
          const v = tile.querySelector('video');
          if (v) { try { v.srcObject = null; } catch {} }
          tile.remove();
        }
      }
      function escapeHtml(s) { return String(s||'').replace(/[<>&"']/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])); }
      let myBroadcastStream = null;
      function addLocalBroadcastTile(stream) {
        removeLocalPlaceholder();
        const slot = document.getElementById('cam-controller-slot');
        let tile = document.getElementById('local-broadcast-tile');
        if (!tile) {
          tile = document.createElement('div');
          tile.id = 'local-broadcast-tile';
          tile.className = 'cam-tile';
          tile.style.setProperty('--cam-aspect', '1');  // controllers are locked 1:1
          tile.innerHTML =
            '<video autoplay muted playsinline></video>' +
            '<div class="rt-label">' + escapeHtml(NICKNAME) + ' (you)</div>' +
            '<div class="local-ctrls">' +
              '<button class="stop" title="Stop broadcasting" onclick="vToggleBroadcast()">⏻</button>' +
              '<button id="my-vid-btn" title="Mute video" onclick="vMuteMyVideo()">🎥</button>' +
              '<button id="my-aud-btn" title="Mute audio" onclick="vMuteMyAudio()">🎤</button>' +
            '</div>';
          slot.insertBefore(tile, slot.firstChild);
        }
        tile.querySelector('video').srcObject = stream;
        const aud = document.getElementById('my-aud-btn');
        if (aud) aud.disabled = !stream.getAudioTracks()[0];
      }
      function removeLocalBroadcastTile() {
        const tile = document.getElementById('local-broadcast-tile');
        if (tile) tile.remove();
      }
      function addLocalPlaceholder() {
        if (document.getElementById('local-broadcast-tile')) return;
        if (document.getElementById('local-cam-placeholder')) return;
        const slot = document.getElementById('cam-controller-slot');
        if (!slot) return;
        const tile = document.createElement('div');
        tile.id = 'local-cam-placeholder';
        tile.className = 'cam-tile local-cam-placeholder';
        tile.style.setProperty('--cam-aspect', '1');
        tile.innerHTML = '<button class="placeholder-btn" onclick="vToggleBroadcast()">📹 Enable my webcam</button>';
        slot.insertBefore(tile, slot.firstChild);
      }
      function removeLocalPlaceholder() {
        const tile = document.getElementById('local-cam-placeholder');
        if (tile) tile.remove();
      }
      async function vToggleBroadcast() {
        if (myBroadcastStream) {
          // Stop broadcasting: unpublish (renegotiate) so the owner→us stream keeps flowing.
          if (wsSig?.readyState === 1) wsSig.send(JSON.stringify({ type: 'broadcast-state', broadcasting: false }));
          if (window.__rtc) await window.__rtc.unpublish();
          myBroadcastStream.getTracks().forEach(t => t.stop());
          myBroadcastStream = null;
          removeLocalBroadcastTile();
          addLocalPlaceholder();
          return;
        }
        try {
          // Controllers are locked at 1:1 — request a square frame so all viewers see the
          // controller's tile at the same square aspect regardless of their physical camera.
          const SQUARE = { width: { ideal: 640 }, height: { ideal: 640 }, aspectRatio: { ideal: 1 } };
          try {
            myBroadcastStream = await navigator.mediaDevices.getUserMedia({ video: SQUARE, audio: true });
          } catch (e1) {
            myBroadcastStream = await navigator.mediaDevices.getUserMedia({ video: SQUARE });
          }
          addLocalBroadcastTile(myBroadcastStream);
          applyMyBroadcastTrackState();  // honour current standby state
          if (wsSig?.readyState === 1) wsSig.send(JSON.stringify({ type: 'broadcast-state', broadcasting: true }));
          broadcastTrackState();
          if (window.__rtc) await window.__rtc.publishToAll();
        } catch (e) { alert('Camera failed: ' + e.message); }
      }
      function vMuteMyVideo() {
        if (!myBroadcastStream) return;
        const t = myBroadcastStream.getVideoTracks()[0]; if (!t) return;
        t._userMuted = !t._userMuted;
        applyMyBroadcastTrackState();
        broadcastTrackState();
        const b = document.getElementById('my-vid-btn');
        if (b) { b.classList.toggle('muted', !!t._userMuted); b.title = t._userMuted ? 'Unmute video' : 'Mute video'; }
      }
      function vMuteMyAudio() {
        if (!myBroadcastStream) return;
        const t = myBroadcastStream.getAudioTracks()[0]; if (!t) return;
        t._userMuted = !t._userMuted;
        applyMyBroadcastTrackState();
        broadcastTrackState();
        const b = document.getElementById('my-aud-btn');
        if (b) { b.classList.toggle('muted', !!t._userMuted); b.title = t._userMuted ? 'Unmute audio' : 'Mute audio'; }
      }
      function applyBroadcastCard(s) {
        // Show/hide the local placeholder tile based on broadcast permission.
        const myP = (s.participants || []).find(p => p.email === MY_EMAIL);
        // Mirror the server-side gate: must be the active controller (canControl),
        // global must be on, and canBroadcast must be set. canControl can flip
        // mid-session (sole-controller reassignment) so we re-read from state.
        const allowed = !!(myP && myP.canControl) && !!s?.ownerCamera?.allowControllerBroadcast && !!(myP && myP.canBroadcast);
        if (!allowed) {
          // Permission revoked mid-session — drop any active broadcast.
          if (myBroadcastStream) {
            if (wsSig?.readyState === 1) wsSig.send(JSON.stringify({ type: 'broadcast-state', broadcasting: false }));
            if (window.__rtc) window.__rtc.unpublish();
            myBroadcastStream.getTracks().forEach(t => t.stop());
            myBroadcastStream = null;
            removeLocalBroadcastTile();
          }
          removeLocalPlaceholder();
          return;
        }
        if (!myBroadcastStream) addLocalPlaceholder();
      }
      let __stepState = null, __repeatState = null, __pumpOnState = false;
      function renderPumpLine() {
        const el = document.getElementById('pump-status');
        const count = document.getElementById('pump-count');
        const cycEl = document.getElementById('cycle-status');
        if (!el || !count || !cycEl) return;
        const stateLabel = __pumpOnState ? 'Running' : 'Idle';
        el.classList.toggle('idle', !__pumpOnState);
        el.querySelector('.pump-state').textContent = stateLabel;
        if (__stepState && __stepState.indefinite) {
          count.textContent = '(manual)';
        } else if (__stepState && __stepState.durationMs > 0) {
          const elapsed = Date.now() - __stepState.startedAt;
          const remaining = Math.max(0, Math.ceil((__stepState.durationMs - elapsed) / 1000));
          count.textContent = '(' + remaining + 's)';
        } else {
          count.textContent = '';
        }
        cycEl.textContent = __repeatState ? 'Cycles: ' + __repeatState.iteration + '/' + __repeatState.times : '';
      }
      setInterval(renderPumpLine, 250);

      let __isStandby = false;
      const __peerTrackState = new Map();
      function broadcastTrackState() {
        if (!wsSig || wsSig.readyState !== 1 || !myBroadcastStream) return;
        const v = myBroadcastStream.getVideoTracks()[0];
        const a = myBroadcastStream.getAudioTracks()[0];
        wsSig.send(JSON.stringify({
          type: 'track-state',
          videoMuted: !!(v && v._userMuted),
          audioMuted: !!(a && a._userMuted),
        }));
      }
      function applyPeerTrackState(email, videoMuted, audioMuted) {
        __peerTrackState.set(email, { videoMuted: !!videoMuted, audioMuted: !!audioMuted });
        const tile = document.getElementById('rt-' + cssId(email));
        if (tile) {
          tile.classList.toggle('peer-video-muted', !!videoMuted);
          tile.classList.toggle('peer-audio-muted', !!audioMuted);
        }
      }
      function applyMyBroadcastTrackState() {
        if (!myBroadcastStream) return;
        for (const track of myBroadcastStream.getTracks()) {
          track.enabled = !__isStandby && !track._userMuted;
        }
      }
      function applyStandby(s) {
        const stage = document.getElementById('session-stage');
        const overlay = document.getElementById('standby-overlay');
        const text = overlay && overlay.querySelector('.standby-text');
        if (!stage || !overlay) return;
        __isStandby = !!(s.active && (s.paused || s.emergencyStopped));
        stage.classList.toggle('standby', __isStandby);
        overlay.classList.toggle('active', __isStandby);
        if (text) {
          if (s.emergencyStopped) { text.textContent = 'E-STOP'; text.style.color = '#f08484'; }
          else { text.textContent = 'Please Stand By'; text.style.color = '#f0c674'; }
        }
        // Black out every cam tile + cut outgoing tracks during standby.
        document.querySelectorAll('.cam-tile').forEach(t => t.classList.toggle('standby-blackout', __isStandby));
        applyMyBroadcastTrackState();
      }
      // --- Dual-Target satellite handshake (local PumpDirect bridge) ---
      // Fired when my own participant entry shows canTarget==='pending'.
      // Probes localhost satellite endpoints, claims a pairing token, and
      // reports back via WS so the host can flip canTarget to true/false.
      function _satSend(obj) {
        try { if (wsSig && wsSig.readyState === 1) wsSig.send(JSON.stringify(obj)); } catch {}
      }
      async function _runSatelliteHandshake(sessionId) {
        try {
          const sr = await fetch('http://localhost:3001/api/satellite/status', { cache: 'no-store' });
          if (!sr.ok) throw new Error('localhost satellite returned ' + sr.status);
          const status = await sr.json();
          if (!status.ready) {
            _satSend({ type: 'satellite-claim', ok: false, reason: 'device not calibrated' });
            return;
          }
          const cr = await fetch('http://localhost:3001/api/satellite/claim', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hostUrl: location.origin, hostEmail: OWNER_EMAIL, sessionId: sessionId || '' }),
          });
          if (!cr.ok) {
            const e = await cr.json().catch(() => ({}));
            _satSend({ type: 'satellite-claim', ok: false, reason: e.error || 'claim refused' });
            return;
          }
          const claim = await cr.json();
          window.__satellitePairing = claim;
          _satSend({ type: 'satellite-claim', ok: true, token: claim.token, deviceLabel: claim.deviceLabel, version: claim.version });
          // Open the state-relay SSE stream so the host can render our pump's
          // capacity / pumpOn / current-step on the second gauge in real time.
          _openSatelliteStateRelay(claim.token);
        } catch (e) {
          _satSend({ type: 'satellite-claim', ok: false, reason: 'PumpDirect not reachable on localhost:3001 — install/start it on this machine' });
        } finally {
          window.__satelliteInFlight = false;
        }
      }
      // beforeunload beacon: if we hold a pairing, tell the local satellite
      // to release. Pure cleanup — the WS-close grace path handles host-side
      // canTarget release independently.
      window.addEventListener('beforeunload', () => {
        const p = window.__satellitePairing;
        if (!p || !p.token) return;
        try {
          const data = new Blob([JSON.stringify({ token: p.token })], { type: 'application/json' });
          navigator.sendBeacon('http://localhost:3001/api/satellite/release', data);
        } catch {}
      });
      // EventSource subscription to the local PD's state events; forwards
      // each tick to the host as 'target-state-update'. Closes on tab unload.
      function _openSatelliteStateRelay(token) {
        try {
          if (window.__satelliteES) try { window.__satelliteES.close(); } catch {}
          const es = new EventSource('http://localhost:3001/api/satellite/state?token=' + encodeURIComponent(token));
          es.onmessage = (ev) => {
            let snapshot;
            try { snapshot = JSON.parse(ev.data); } catch { return; }
            _satSend({ type: 'target-state-update', snapshot });
          };
          es.onerror = () => { /* EventSource auto-retries */ };
          window.__satelliteES = es;
        } catch (e) {
          console.warn('satellite state relay failed:', e.message);
        }
      }
      // While we hold the T slot, re-check the satellite every 8s. If the
      // device drops (uncalibrated, gone, PumpDirect crashed) we self-demote
      // by sending satellite-claim ok:false so the host frees the slot.
      setInterval(async () => {
        const s = window.__lastVisitorState || {};
        const myP = (s.participants || []).find(p => p.email === MY_EMAIL);
        if (!myP || myP.canTarget !== true) return;
        try {
          const r = await fetch('http://localhost:3001/api/satellite/status', { cache: 'no-store' });
          if (!r.ok) throw new Error('status ' + r.status);
          const status = await r.json();
          if (!status.ready) {
            _satSend({ type: 'satellite-claim', ok: false, reason: 'local device dropped — ' + (status.deviceLabel ? 'no longer calibrated' : 'no primary device') });
          }
        } catch {
          _satSend({ type: 'satellite-claim', ok: false, reason: 'local PumpDirect unreachable' });
        }
      }, 8000);

      function applyState(s) {
        window.__lastVisitorState = s;
        applyStandby(s);
        renderParticipants(s);
        renderMilestonePane(s);
        renderTextOverlays(s);
        __pumpOnState = !!s.pumpOn;
        __stepState = s.currentStep || null;
        __repeatState = s.currentRepeat || null;
        renderPumpLine();
        // If my own participant flags changed since page load, reload so server-rendered
        // sections (action buttons / "not in session" banner / etc.) match the new permissions.
        const myP = (s.participants || []).find(p => p.email === MY_EMAIL);
        // canTarget transition observer: fire satellite handshake when it
        // flips into 'pending'. Survives reconnects (resets __satelliteWanted
        // on each state event so a re-pending re-triggers).
        const wantHandshake = !!(myP && myP.canTarget === 'pending');
        if (wantHandshake && !window.__satelliteInFlight && window.__satelliteWanted !== 'pending') {
          window.__satelliteInFlight = true;
          _runSatelliteHandshake(s.startedAt || s.sessionProfileId || '');
        }
        window.__satelliteWanted = myP ? myP.canTarget : false;
        const sig = myP ? (Number(!!myP.canConnect) + ':' + Number(!!myP.canControl) + ':' + Number(!!myP.canBroadcast) + ':' + Number(!!myP.muted)) : 'gone';
        if (window.__mySig !== undefined && window.__mySig !== sig && s.active) {
          location.reload();
          return;
        }
        window.__mySig = sig;
        applyBroadcastCard(s);
        const r = 70, c = 2 * Math.PI * r;
        const cap = Math.max(0, s.capacity || 0);
        const needle = Math.min(100, cap);
        const over = cap > 100;
        const dash = (needle / 100) * c;
        const fill = document.getElementById('gauge-fill');
        if (fill) {
          fill.setAttribute('stroke-dasharray', dash.toFixed(1) + ' ' + (c - dash).toFixed(1));
          fill.setAttribute('stroke', over ? '#f0c674' : '#2a6df4');
        }
        const text = document.getElementById('gauge-pct');
        if (text) { text.textContent = Math.round(cap) + '%'; text.setAttribute('fill', over ? '#f0c674' : 'currentColor'); }
        // template-action button lock (data-action-id only); pump-toggle and misc handled separately
        const running = s.currentActionTemplateId;
        const introGated = !!s.introPending;
        const lockAll = !!running || introGated;
        document.querySelectorAll('.action-btn[data-action-id]').forEach(btn => {
          const id = btn.dataset.actionId;
          if (introGated) {
            btn.disabled = true;
            btn.classList.remove('running');
          } else if (running) {
            btn.disabled = running !== id;
            if (running === id) btn.classList.add('running');
            else btn.classList.remove('running');
          } else {
            btn.disabled = false;
            btn.classList.remove('running');
          }
        });
        const toggle = document.querySelector('.pump-toggle');
        if (toggle) {
          toggle.textContent = running ? '⏻ Pump Off' : '⏵ Pump On';
          toggle.style.background = running ? '#a13030' : '#1a8a4d';
          toggle.style.color = '#fff';
          toggle.disabled = introGated;
        }
        document.querySelectorAll('.misc-action-btn').forEach(b => { b.disabled = lockAll; });
        document.querySelectorAll('.minigame-btn').forEach(b => { b.disabled = lockAll; });
        // if session went idle (active→false) or vice versa, reload to re-render layout
        if (s.active !== window.__visitorActive) {
          if (window.__visitorActive !== undefined) location.reload();
          window.__visitorActive = s.active;
        }
        // Intro pending: toggle the lock notice in place. No reload — a reload
        // would tear down the WebRTC mesh and visitors would lose their host
        // cam stream every time an intro ends.
        const introNoteEl = document.getElementById('v-intro-lock-note');
        if (introNoteEl) introNoteEl.style.display = s.introPending ? 'block' : 'none';
        window.__visitorIntro = s.introPending;
      }
      async function renderChat(m) {
        const log = document.getElementById('chat-log');
        if (!log) return;
        let text = m.text || '';
        if (m.encrypted) {
          if (!window.__chat.ready()) { window.__chat.bufferIfNotReady(m); return; }
          text = (await window.__chat.decrypt(m.encrypted)) || '[encrypted — key mismatch]';
        }
        let imageDataUrl = null;
        if (m.type === 'image' && m.image) {
          if (m.image.encrypted) {
            if (!window.__chat.ready()) { window.__chat.bufferIfNotReady(m); return; }
            imageDataUrl = await window.__chat.decrypt(m.image.encrypted);
          } else if (m.image.dataUrl) {
            imageDataUrl = m.image.dataUrl;
          }
        }
        const row = document.createElement('div');
        // NOTE: this used to be 'chat-row' which collided with the outer grid
        // container's class — every message rendered as a 2-column grid and
        // pushed the page off-screen on mobile. Renamed to 'chat-msg'.
        row.className = 'chat-msg' + (m.type === 'system' ? ' system' : '');
        const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (m.type === 'system') {
          row.innerHTML = escapeHtml(text) + ' <span style="opacity:0.6">· ' + time + '</span>';
        } else if (m.type === 'image' && imageDataUrl) {
          row.innerHTML = '<strong style="color:#6ddc9b">' + escapeHtml(m.fromNickname) + '</strong> <span style="opacity:0.6;font-size:0.85rem">' + time + '</span><br>' +
            '<img src="' + imageDataUrl + '" alt="snapshot" style="max-width:100%;width:280px;height:auto;border-radius:8px;display:block;margin-top:6px">';
        } else {
          row.innerHTML = '<strong style="color:#6ddc9b">' + escapeHtml(m.fromNickname) + '</strong> <span style="opacity:0.6;font-size:0.85rem">' + time + '</span><br>' + escapeHtml(text);
        }
        log.appendChild(row);
        log.scrollTop = log.scrollHeight;
      }
      // A/B toggle helpers — same shape as the Launchpad's, per-tab.
      function _abTarget() {
        try { return sessionStorage.getItem('pd-ab-target') === 'target' ? 'target' : 'host'; } catch { return 'host'; }
      }
      function _setAbTarget(v) {
        const next = v === 'target' ? 'target' : 'host';
        try { sessionStorage.setItem('pd-ab-target', next); } catch {}
        document.querySelectorAll('.ab-toggle .ab-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.ab === next);
        });
      }
      window.addEventListener('DOMContentLoaded', () => _setAbTarget(_abTarget()));

      async function vFire(id) {
        const r = await fetch('/api/visitor/fire-action', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ actionTemplateId: id, target: _abTarget() }) });
        if (!r.ok) { const d = await r.json(); alert(d.error || 'failed'); }
      }
      async function vPumpOff() {
        const r = await fetch('/api/visitor/pump-off', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ target: _abTarget() }) });
        if (!r.ok) { const d = await r.json(); alert(d.error || 'failed'); }
      }
      async function vPumpOn() {
        const r = await fetch('/api/visitor/pump-on', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ target: _abTarget() }) });
        if (!r.ok) { const d = await r.json(); alert(d.error || 'failed'); }
      }
      function vPumpToggle() {
        const s = window.__lastVisitorState || {};
        const ab = _abTarget();
        const running = ab === 'target'
          ? !!(s.targetState && s.targetState.currentActionTemplateId)
          : !!s.currentActionTemplateId;
        if (running) vPumpOff(); else vPumpOn();
      }
      async function vTimed() {
        const s = prompt('Duration in seconds:', '10');
        if (s == null) return;
        const seconds = parseFloat(s);
        if (!Number.isFinite(seconds) || seconds <= 0) return alert('positive seconds required');
        const r = await fetch('/api/visitor/timed', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ seconds, target: _abTarget() }) });
        if (!r.ok) { const d = await r.json(); alert(d.error || 'failed'); }
      }
      async function vConfirmStart() {
        const r = await fetch('/api/visitor/accept-start', { method: 'POST' });
        if (!r.ok) { const d = await r.json(); alert(d.error || 'failed'); }
      }
      // Target-side safety: bypass the host and hit our own local satellite
      // /pump-off. Uses the pairing token cached during the handshake.
      async function vStopMyPump() {
        const p = window.__satellitePairing;
        if (!p || !p.token) return alert('Local PumpDirect pairing not active');
        if (!confirm('Force-stop YOUR pump now?')) return;
        try {
          const r = await fetch('http://localhost:3001/api/satellite/pump-off', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: p.token }),
          });
          if (!r.ok) alert('Local pump-off failed: HTTP ' + r.status);
        } catch (e) { alert('Could not reach localhost PumpDirect: ' + e.message); }
      }
      async function vCycle() {
        const onSec = parseFloat(prompt('On (seconds):', '2'));
        if (!Number.isFinite(onSec) || onSec <= 0) return;
        const offSec = parseFloat(prompt('Off (seconds):', '1'));
        if (!Number.isFinite(offSec) || offSec <= 0) return;
        const times = parseInt(prompt('Repeat times:', '5'), 10);
        if (!Number.isInteger(times) || times <= 0) return;
        const r = await fetch('/api/visitor/cycle', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ onSec, offSec, times, target: _abTarget() }) });
        if (!r.ok) { const d = await r.json(); alert(d.error || 'failed'); }
      }
      async function vSend() {
        const input = document.getElementById('chat-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        // E2EE: encrypt client-side so server (and CF edge) only see ciphertext.
        const encrypted = window.__chat?.ready() ? await window.__chat.encrypt(text) : null;
        const body = encrypted ? { encrypted } : { text };
        const r = await fetch('/api/visitor/chat', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
        if (!r.ok) { const d = await r.json(); alert(d.error || 'failed'); }
      }
      function _sendVisibility() {
        if (wsSig && wsSig.readyState === 1) {
          wsSig.send(JSON.stringify({ type: 'visibility', hidden: !!document.hidden }));
        }
      }
      document.addEventListener('visibilitychange', _sendVisibility);
      function connect() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(proto + '://' + location.host + '/ws/visitor');
        wsSig = ws;
        if (window.__rtc) {
          window.__rtc.init({
            sendSig: (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
            getLocalStream: () => myBroadcastStream,
            onRemoteStream: attachRemoteTile,
            onRemoteGone: removeRemoteTile,
          });
        }
        ws.onopen = () => { _sendVisibility(); };
        ws.onmessage = async (e) => {
          const m = JSON.parse(e.data);
          if (m.type === 'state') applyState(m.state);
          else if (m.type === 'chat-key') {
            const buffered = await window.__chat.setKey(m.key);
            if (buffered && buffered.length) buffered.forEach(renderChat);
          }
          else if (m.type === 'chat') renderChat(m.message);
          else if (m.type === 'chat-history') {
            const log = document.getElementById('chat-log');
            if (log) { log.innerHTML = ''; (m.messages || []).forEach(renderChat); }
          } else if (m.type === 'track-state') {
            applyPeerTrackState(m.email, !!m.videoMuted, !!m.audioMuted);
          } else if (m.type === 'broadcast-state' && m.broadcasting === false) {
            // Peer stopped broadcasting — drop their tile but keep the PC alive
            // for any other direction (e.g. owner's still-active stream).
            removeRemoteTile(m.email);
            if (window.__rtc) window.__rtc.onSignalingMsg(m);
          } else if (m.type === 'force-unbroadcast') {
            // Server revoked broadcast permission (owner toggled global off,
            // unchecked canBroadcast/canControl, etc). Tear down our publish.
            if (myBroadcastStream) {
              if (window.__rtc) window.__rtc.unpublish();
              myBroadcastStream.getTracks().forEach(t => t.stop());
              myBroadcastStream = null;
              removeLocalBroadcastTile();
            }
            removeLocalPlaceholder();
            alert('Your broadcast was stopped: ' + (m.reason || 'permission revoked'));
          } else if (m.type === 'overlay') {
            renderOverlay(m);
          } else if (m.type === 'presence-msg') {
            const el = document.getElementById('chat-presence-line');
            if (el) el.textContent = m.text || '';
          } else if (m.type === 'template-snapshot') {
            // Dual-Target: host pushed the action template library after our
            // satellite handshake landed. Cache in memory; step 6 wires it
            // into the A/B-toggle action grid renderer.
            window.__dualTemplates = {
              templates: Array.isArray(m.templates) ? m.templates : [],
              templateProfile: m.templateProfile || null,
              profileMode: m.profileMode || 'single-target',
              receivedAt: Date.now(),
            };
          } else if (m.type === 'remote-action') {
            // Dual-Target: someone fired a button targeting our pump. Proxy
            // the inline steps to our local PumpDirect's satellite endpoint,
            // which will run them on our primary device. Token authenticates
            // the request — must match the one our local satellite issued.
            fetch('http://localhost:3001/api/satellite/run-action', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token: m.token, steps: m.steps, label: m.label }),
            }).then(r => {
              if (!r.ok) console.warn('satellite run-action rejected:', r.status);
            }).catch(err => console.warn('satellite run-action proxy failed:', err.message));
          } else if (m.type === 'remote-pump-off') {
            // Dual-Target: host (or another controller) hit Pump Off targeted
            // at our pump. Proxy directly to /api/satellite/pump-off.
            fetch('http://localhost:3001/api/satellite/pump-off', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ token: m.token }),
            }).catch(err => console.warn('satellite pump-off proxy failed:', err.message));
          } else {
            if (window.__rtc) window.__rtc.onSignalingMsg(m);
            if (m.type === 'peer-joined' && myBroadcastStream) setTimeout(broadcastTrackState, 800);
          }
        };
        ws.onclose = () => { wsSig = null; setTimeout(connect, 1500); };
      }
      connect();
    </script>
  </body></html>`;
}

router.get('/', (req, res) => {
  res.type('html').send(renderVisitorPage(req));
});

router.post('/api/visitor/chat', (req, res) => {
  const email = req.user?.email;
  if (!email) return res.status(401).json({ error: 'unauthenticated' });
  const profile = activeProfile();
  if (!profile?.settings?.chatroomEnabled) return res.status(403).json({ error: 'chat is disabled in this session' });
  const participant = findParticipant(email);
  if (session.getState().active && (!participant || participant.canConnect === false)) {
    return res.status(403).json({ error: 'not in this session' });
  }
  if (participant?.muted) return res.status(403).json({ error: 'you are muted' });
  const account = findAccount(email);
  const nickname = account?.nickname || email.split('@')[0];
  const encrypted = typeof req.body?.encrypted === 'string' ? req.body.encrypted : null;
  const text = (req.body?.text || '').trim();
  if (!encrypted && !text) return res.status(400).json({ error: 'empty message' });
  chat.push({ fromEmail: email, fromNickname: nickname, text, encrypted });
  res.json({ ok: true });
});

// Dual-target visitor target field: normalize and clamp.
function _resolveVisitorTarget(req, state) {
  const t = req.body?.target;
  if (state.mode !== 'dual-target') return 'host';
  return t === 'target' ? 'target' : 'host';
}

// Deliver a remote-action WS message to the paired target's visitor (which
// will proxy it to their local PumpDirect's satellite). Returns true on
// successful delivery, false otherwise (no pair, no WS connection).
function _emitVisitorRemoteAction(label, steps) {
  const pair = session.getActiveTargetPair();
  if (!pair || !pair.token) {
    console.log(`remote-action "${label}" dropped — no paired target with token`);
    return false;
  }
  const signaling = require('../services/signaling-service');
  const delivered = signaling.deliver(pair.email, { type: 'remote-action', token: pair.token, label, steps });
  if (delivered) {
    try {
      const { emitOverlay } = require('../services/event-bus');
      emitOverlay({ kind: 'action-flash', text: `→ ${pair.deviceLabel || 'target'}: ${label}` });
    } catch {}
  }
  return delivered;
}

router.post('/api/visitor/fire-action', async (req, res) => {
  const email = req.user?.email;
  if (!email) return res.status(401).json({ error: 'unauthenticated' });
  const state = session.getState();
  if (!state.active) return res.status(400).json({ error: 'no active session' });
  if (state.introPending) return res.status(400).json({ error: 'intro in progress — action panel locked' });
  if (state.mode === 'dual-target' && !session.isSessionFullyStarted()) return res.status(400).json({ error: 'session not started — both parties must confirm' });
  const participant = findParticipant(email);
  const isTargetUser = !!(participant && participant.canTarget === true);
  // In dual mode, controllers only fire if the host has ticked
  // "Allow visitor controllers in dual mode". Targets always can.
  const dualMode = state.mode === 'dual-target';
  const allowVisCtrl = dualMode ? !!state.allowVisitorControllersInDual : true;
  const canFire = (participant && participant.canControl && allowVisCtrl) || (dualMode && isTargetUser);
  if (!participant || !canFire) {
    return res.status(403).json({ error: 'you do not have device control permission for this session' });
  }
  const account = findAccount(email);
  const nickname = account?.nickname || email.split('@')[0];
  const target = _resolveVisitorTarget(req, state);
  if (target === 'target') {
    const tplData = require('../services/templates-service').load();
    const action = tplData.actionTemplates.find(a => a.id === req.body?.actionTemplateId);
    if (!action) return res.status(404).json({ error: 'action template not found' });
    _emitVisitorRemoteAction(action.name, action.steps);
    return res.json({ ok: true, target: 'target', stubbed: true });
  }
  try {
    await actionEngine.fireAction({
      actionTemplateId: req.body?.actionTemplateId,
      byEmail: email,
      byNickname: nickname,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function _visitorCtx(req, res) {
  const email = req.user?.email;
  if (!email) { res.status(401).json({ error: 'unauthenticated' }); return null; }
  const state = session.getState();
  if (!state.active) { res.status(400).json({ error: 'no active session' }); return null; }
  if (state.introPending) { res.status(400).json({ error: 'intro in progress — action panel locked' }); return null; }
  if (state.mode === 'dual-target' && !session.isSessionFullyStarted()) { res.status(400).json({ error: 'session not started — both parties must confirm' }); return null; }
  const participant = findParticipant(email);
  const isTargetUser = !!(participant && participant.canTarget === true);
  const dualMode = state.mode === 'dual-target';
  const allowVisCtrl = dualMode ? !!state.allowVisitorControllersInDual : true;
  const canFire = (participant && participant.canControl && allowVisCtrl) || (dualMode && isTargetUser);
  if (!participant || !canFire) {
    res.status(403).json({ error: 'you do not have device control permission for this session' });
    return null;
  }
  const account = findAccount(email);
  return { email, nickname: account?.nickname || email.split('@')[0] };
}

router.post('/api/visitor/pump-off', (req, res) => {
  const ctx = _visitorCtx(req, res); if (!ctx) return;
  try {
    const target = _resolveVisitorTarget(req, session.getState());
    if (target === 'target') {
      const pair = session.getActiveTargetPair();
      if (!pair || !pair.token) throw new Error('no paired target with token');
      const signaling = require('../services/signaling-service');
      const delivered = signaling.deliver(pair.email, { type: 'remote-pump-off', token: pair.token });
      if (!delivered) throw new Error('target not connected');
      require('../services/event-bus').emitOverlay({ kind: 'action-flash', text: `${ctx.nickname} stopped ${pair.deviceLabel || 'target'}` });
      return res.json({ ok: true, target: 'target' });
    }
    actionEngine.abort(null);
    require('../services/event-bus').emitOverlay({ kind: 'action-flash', text: `${ctx.nickname} stopped the pump` });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Target accepts the dual-mode session start. Caller must be the active T.
// Voyeurs and non-target controllers can't accept.
router.post('/api/visitor/accept-start', (req, res) => {
  const email = req.user?.email;
  if (!email) return res.status(401).json({ error: 'unauthenticated' });
  const state = session.getState();
  if (!state.active) return res.status(400).json({ error: 'no active session' });
  if (state.mode !== 'dual-target') return res.status(400).json({ error: 'mutual consent only applies in dual-target mode' });
  const me = (state.participants || []).find(p => p.email === email);
  if (!me || me.canTarget !== true) {
    return res.status(403).json({ error: 'only the active target can accept' });
  }
  session.acceptStart('target');
  res.json({ ok: true });
});

router.post('/api/visitor/pass-control', (req, res) => {
  // Current controller hands their role to a fellow visitor. Server-enforced:
  // requester must currently have canControl; target must be a session
  // participant. The new controller starts with canBroadcast=false so the
  // V tickbox effectively resets.
  const email = req.user?.email;
  if (!email) return res.status(401).json({ error: 'unauthenticated' });
  const state = session.getState();
  if (!state.active) return res.status(400).json({ error: 'no active session' });
  const me = (state.participants || []).find(p => p.email === email);
  if (!me || !me.canControl) return res.status(403).json({ error: 'only the current controller can hand off' });
  const targetEmail = String(req.body?.to || '').trim().toLowerCase();
  if (!targetEmail || targetEmail === email) return res.status(400).json({ error: 'invalid target' });
  const target = (state.participants || []).find(p => p.email === targetEmail);
  if (!target) return res.status(404).json({ error: 'target not in session' });
  try {
    const profile = session.getProfile(state.sessionProfileId);
    const next = profile.allowedParticipants.map(p => {
      if (p.email === email)        return { ...p, canControl: false };
      if (p.email === targetEmail)  return { ...p, canControl: true, canBroadcast: false };
      return p;
    });
    session.updateProfile(state.sessionProfileId, { allowedParticipants: next });
    // Keep the live session participants in sync too.
    try { session.updateParticipantFlags(email,       { canControl: false }); } catch {}
    try { session.updateParticipantFlags(targetEmail, { canControl: true, canBroadcast: false }); } catch {}
    require('../services/event-bus').emitState(session.getState());
    // No chat narration — the participant-list flags carry the role shift.
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/visitor/pump-on', async (req, res) => {
  const ctx = _visitorCtx(req, res); if (!ctx) return;
  try {
    const target = _resolveVisitorTarget(req, session.getState());
    if (target === 'target') {
      _emitVisitorRemoteAction('Pump On', [{ type: 'on', durationMs: 24 * 3600 * 1000, indefinite: true }]);
      return res.json({ ok: true, target: 'target', stubbed: true });
    }
    await actionEngine.fireAction({
      inline: { name: 'Pump On', steps: [{ type: 'on', durationMs: 24 * 3600 * 1000, indefinite: true }] },
      byEmail: ctx.email, byNickname: ctx.nickname,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/visitor/timed', async (req, res) => {
  const ctx = _visitorCtx(req, res); if (!ctx) return;
  try {
    const sec = parseFloat(req.body?.seconds);
    if (!Number.isFinite(sec) || sec <= 0) throw new Error('positive seconds required');
    const target = _resolveVisitorTarget(req, session.getState());
    const steps = [{ type: 'on', durationMs: Math.round(sec * 1000) }];
    if (target === 'target') {
      _emitVisitorRemoteAction(`Timed ${sec}s`, steps);
      return res.json({ ok: true, target: 'target', stubbed: true });
    }
    await actionEngine.fireAction({
      inline: { name: `Timed ${sec}s`, steps },
      byEmail: ctx.email, byNickname: ctx.nickname,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/visitor/minigame/dice-roll', async (req, res) => {
  const ctx = _visitorCtx(req, res); if (!ctx) return;
  try {
    await minigames.runDiceRoll({
      count: req.body?.count,
      mode: req.body?.mode,
      byEmail: ctx.email,
      byNickname: ctx.nickname,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/visitor/minigame/prize-wheel', async (req, res) => {
  const ctx = _visitorCtx(req, res); if (!ctx) return;
  try {
    // Server-side allow-list: visitor can only spin wheels exposed by the
    // active milestone's button OR the always-available pool.
    const state = session.getState();
    const profile = activeProfile();
    const tplData = templatesSvc.load();
    const tpl = profile ? tplData.templateProfiles.find(p => p.id === profile.templateProfileId) : null;
    const wheelId = req.body?.wheelId;
    let active = null;
    if (state.active && tpl?.milestones?.length) {
      if (state.capacity >= 100) active = tpl.milestones.find(m => m.is100Plus) || null;
      if (!active) active = tpl.milestones
        .filter(m => !m.is100Plus && state.capacity >= m.capacityMin && state.capacity <= m.capacityMax)
        .sort((a, b) => b.capacityMin - a.capacityMin)[0] || null;
    }
    const allowed = Array.from(new Set([
      ...((active?.minigameConfig?.['prize-wheel']?.wheelIds) || []),
      ...((tpl?.defaultMinigameConfig?.['prize-wheel']?.wheelIds) || []),
    ]));
    // If a specific wheelId is pinned, it must be in the allow-list. Otherwise
    // the server picks one at random from the wheelIds the client offered
    // (intersected with the allow-list).
    if (wheelId && !allowed.includes(wheelId)) return res.status(403).json({ error: 'this wheel is not available at this button' });
    const result = minigames.requestPrizeWheel({
      wheelId,
      wheelIds: req.body?.wheelIds,
      allowedWheelIds: allowed,
      byEmail: ctx.email,
      byNickname: ctx.nickname,
    });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});


router.post('/api/visitor/cycle', async (req, res) => {
  const ctx = _visitorCtx(req, res); if (!ctx) return;
  try {
    const onSec = parseFloat(req.body?.onSec);
    const offSec = parseFloat(req.body?.offSec);
    const times = parseInt(req.body?.times, 10);
    if (!Number.isFinite(onSec) || onSec <= 0) throw new Error('on seconds required');
    if (!Number.isFinite(offSec) || offSec <= 0) throw new Error('off seconds required');
    if (!Number.isInteger(times) || times <= 0) throw new Error('repeat times required');
    const target = _resolveVisitorTarget(req, session.getState());
    const steps = [{ type: 'repeat', times, steps: [
      { type: 'on', durationMs: Math.round(onSec * 1000) },
      { type: 'off', durationMs: Math.round(offSec * 1000) },
    ]}];
    if (target === 'target') {
      _emitVisitorRemoteAction(`Cycle ${onSec}/${offSec} ×${times}`, steps);
      return res.json({ ok: true, target: 'target', stubbed: true });
    }
    await actionEngine.fireAction({
      inline: { name: `Cycle ${onSec}/${offSec} ×${times}`, steps: [{
        type: 'repeat', times, steps: [
          { type: 'on', durationMs: Math.round(onSec * 1000) },
          { type: 'off', durationMs: Math.round(offSec * 1000) },
        ]
      }] },
      byEmail: ctx.email, byNickname: ctx.nickname,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = { router, renderVisitorPage };
