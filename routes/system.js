const express = require('express');
const WebSocket = require('ws');
const { ownerLayout, escape } = require('../views/layout');
const logger = require('../utils/logger');
const { createLogger } = require('../utils/logger');

const log = createLogger('System');
const router = express.Router();

router.get('/system', (_req, res) => {
  const body = `
    <h2>System <span class="muted" style="font-size:1rem">— live backend logs</span></h2>

    <div class="card">
      <p class="muted" style="margin:0 0 12px">
        Live tail of the Node process. Captures everything routed through the logger and any
        <code>console.error</code> / <code>console.warn</code> emitted from anywhere in the backend.
        Buffer holds the last ${logger.MAX_BUFFER} lines and survives client disconnects.
      </p>
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:14px">
        <label><input type="checkbox" class="lv-filter" value="ERROR" checked> ERROR</label>
        <label><input type="checkbox" class="lv-filter" value="WARN" checked> WARN</label>
        <label><input type="checkbox" class="lv-filter" value="INFO" checked> INFO</label>
        <label><input type="checkbox" class="lv-filter" value="DEBUG"> DEBUG</label>
        <label><input type="checkbox" class="lv-filter" value="TRACE"> TRACE</label>
        <label style="margin-left:auto"><input type="checkbox" id="lv-follow" checked> Auto-scroll</label>
        <button onclick="lvCopy()" style="background:#2a2f3a">Copy visible</button>
        <button onclick="lvClear()" style="background:#2a2f3a">Clear view</button>
      </div>
      <p style="margin:14px 0 6px">
        <input id="lv-search" type="text" placeholder="filter (substring or /regex/)" style="width:60%">
        <span id="lv-status" class="muted" style="font-size:0.9rem;margin-left:12px">connecting…</span>
      </p>
      <pre id="lv-log" style="height:60vh;overflow:auto;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:8px;padding:14px;margin:0;font-size:0.9rem;line-height:1.45;white-space:pre-wrap;word-break:break-word"></pre>
    </div>

    <script>
      const logEl = document.getElementById('lv-log');
      const statusEl = document.getElementById('lv-status');
      const followEl = document.getElementById('lv-follow');
      const searchEl = document.getElementById('lv-search');
      const filters = Array.from(document.querySelectorAll('.lv-filter'));

      let allEntries = [];     // raw entries received
      let ws = null;
      let reconnectTimer = null;
      let reconnectAttempt = 0;

      function levelColor(lv) {
        if (lv === 'ERROR') return '#f08484';
        if (lv === 'WARN')  return '#f0c674';
        if (lv === 'INFO')  return '#e8e8e8';
        if (lv === 'DEBUG') return '#7a8597';
        if (lv === 'TRACE') return '#5a6373';
        return '#e8e8e8';
      }
      function formatTs(ms) {
        const d = new Date(ms);
        return d.toISOString().slice(11, 23);
      }
      function buildMatcher() {
        const filt = new Set(filters.filter(f => f.checked).map(f => f.value));
        const q = searchEl.value.trim();
        let re = null;
        if (q.length > 1 && q.startsWith('/') && q.endsWith('/')) {
          try { re = new RegExp(q.slice(1, -1), 'i'); } catch {}
        }
        return (e) => {
          if (!filt.has(e.level)) return false;
          if (!q) return true;
          const hay = e.prefix + ' ' + e.msg;
          return re ? re.test(hay) : hay.toLowerCase().includes(q.toLowerCase());
        };
      }
      function render() {
        const match = buildMatcher();
        const visible = allEntries.filter(match);
        const html = visible.map(e => {
          const c = levelColor(e.level);
          return '<span style="color:' + c + '">[' + formatTs(e.ts) + '] [' + esc(e.level) + '] [' + esc(e.prefix) + '] ' + esc(e.msg) + '</span>';
        }).join('\\n');
        logEl.innerHTML = html;
        if (followEl.checked) logEl.scrollTop = logEl.scrollHeight;
      }
      function append(e) {
        allEntries.push(e);
        const max = ${logger.MAX_BUFFER};
        if (allEntries.length > max) allEntries = allEntries.slice(-max);
        const match = buildMatcher();
        if (!match(e)) return;
        const c = levelColor(e.level);
        const line = '<span style="color:' + c + '">[' + formatTs(e.ts) + '] [' + esc(e.level) + '] [' + esc(e.prefix) + '] ' + esc(e.msg) + '</span>';
        const sep = logEl.innerHTML ? '\\n' : '';
        logEl.innerHTML = logEl.innerHTML + sep + line;
        if (followEl.checked) logEl.scrollTop = logEl.scrollHeight;
      }
      function esc(s) { return String(s == null ? '' : s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])); }
      function lvClear() { allEntries = []; logEl.innerHTML = ''; }
      function lvCopy() {
        const text = logEl.innerText;
        navigator.clipboard.writeText(text).then(
          () => statusEl.textContent = 'copied ' + text.length + ' chars',
          () => statusEl.textContent = 'copy failed'
        );
      }
      filters.forEach(f => f.addEventListener('change', render));
      searchEl.addEventListener('input', render);

      function connect() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(proto + '://' + location.host + '/ws/system');
        statusEl.textContent = 'connecting…';
        ws.onopen = () => { statusEl.textContent = 'live'; reconnectAttempt = 0; };
        ws.onmessage = ev => {
          let m;
          try { m = JSON.parse(ev.data); } catch { return; }
          if (m.type === 'snapshot') { allEntries = m.entries || []; render(); }
          else if (m.type === 'log') append(m.entry);
        };
        ws.onclose = () => {
          statusEl.textContent = 'disconnected — reconnecting';
          const delay = Math.min(30000, (500 * Math.pow(2, reconnectAttempt))) + Math.floor(Math.random() * 500);
          reconnectAttempt++;
          reconnectTimer = setTimeout(connect, delay);
        };
        ws.onerror = () => {};
      }
      connect();
    </script>
  `;
  res.type('html').send(ownerLayout({ title: 'System', active: 'system', body }));
});

function attachWebSocket(wss) {
  wss.on('connection', (ws) => {
    const snap = logger.snapshot();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'snapshot', entries: snap }));
    }
    const unsub = logger.subscribe((entry) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'log', entry }));
      }
    });
    ws.on('close', () => unsub());
    ws.on('error', (err) => log.warn('system ws error', err.message));
  });
}

module.exports = { router, attachWebSocket };
