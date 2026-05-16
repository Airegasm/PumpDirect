const express = require('express');
const devices = require('../services/devices-service');
const control = require('../services/device-control');
const ha = require('../services/homeassistant-service');
const config = require('../config');
const { ownerLayout, escape } = require('../views/layout');
const { createLogger } = require('../utils/logger');

const logger = createLogger('DevicesRoute');
const router = express.Router();

function pill(state, label) {
  const cls = state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${escape(label)}</span>`;
}

function vendorIdHelp(vendor) {
  return {
    tapo: 'IP',
    kasa: 'IP',
    'kasa-klap': 'IP',
    wyze: 'MAC + Model',
    govee: 'Device ID + SKU',
    tuya: 'Device ID',
    generic: 'IP',
  }[vendor] || 'IP';
}

function renderVendorCredentials() {
  const cfg = config.load();
  const sections = Object.entries(control.VENDOR_INFO)
    .filter(([key]) => key !== 'homeassistant')  // HA has its own card below
    .map(([key, info]) => {
    const stored = (cfg.vendors && cfg.vendors[key]) || {};
    const complete = control.credsComplete(key);
    if (info.credFields.length === 0) {
      if (key === 'kasa') {
        return `<details><summary>${escape(info.name)} ${pill('ok', 'no credentials needed (local)')}</summary>
          <div style="padding:12px">
            <p class="muted">Kasa uses TP-Link's local UDP broadcast protocol (port 9999) — no account or API key required.</p>
            <p><button onclick="dvScanKasa()">Scan for Kasa devices</button></p>
            <div id="kasa-scan-results"></div>
          </div></details>`;
      }
      return `<details><summary>${escape(info.name)} ${pill('ok', 'no credentials needed (local)')}</summary>
        <p class="muted">No account or API key required.</p></details>`;
    }
    const fields = info.credFields.map(f => {
      const isSecret = /password|secret|key|token/i.test(f);
      const display = isSecret && stored[f] ? '••••••••' : (stored[f] || '');
      return `<label style="display:block;margin:8px 0">
        <span class="muted" style="display:inline-block;width:130px">${escape(f)}</span>
        <input type="${isSecret ? 'password' : 'text'}" data-vendor="${key}" data-field="${f}" value="${escape(display)}" style="width:50%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
      </label>`;
    }).join('');
    return `<details>
      <summary>${escape(info.name)} ${complete ? pill('ok', 'credentials saved') : pill('warn', 'needs credentials')}</summary>
      <div style="padding:12px">
        ${fields}
        <p><button onclick="dvSaveCreds('${key}')">Save ${escape(info.name)} credentials</button></p>
      </div>
    </details>`;
  }).join('');
  return `
    <div class="card">
      <h3>Vendor Credentials</h3>
      <p class="muted">Fill in only the vendors you use. Stored in <code>config.json</code> on this machine; never sent to visitors.</p>
      ${sections}
    </div>`;
}

function renderHomeAssistant() {
  const cfg = config.load();
  const ha_ = cfg.vendors?.homeassistant || {};
  return `
    <div class="card">
      <h3>Home Assistant <span class="muted" style="font-size:0.9rem;font-weight:normal">— optional integration</span></h3>
      <p class="muted">Connect a running Home Assistant install to control any HA-supported device (Zigbee, Z-Wave, Matter, Shelly, MQTT, …) as if it were a native vendor. Once connected, add it below with the <strong>Home Assistant</strong> vendor and an entity ID like <code>switch.your_entity</code> (or any other domain with <code>turn_on</code> / <code>turn_off</code>).</p>
      <p>
        <label class="muted" style="display:block;margin:6px 0">Base URL</label>
        <input id="ha-base" type="text" placeholder="http://homeassistant.local:8123"
               value="${escape(ha_.baseUrl || '')}"
               style="width:60%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
      </p>
      <p>
        <label class="muted" style="display:block;margin:6px 0">Long-lived access token (Profile → Security → Create Token)</label>
        <input id="ha-token" type="password" placeholder="${ha_.token ? '•••••••• (saved)' : 'paste token'}"
               style="width:60%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
      </p>
      <p>
        <button onclick="haSave()">Save</button>
        <button onclick="haTest()">Test connection</button>
        <span id="ha-status" class="muted" style="margin-left:12px;font-size:0.95rem"></span>
      </p>
    </div>`;
}

function renderAddForm() {
  const vendors = Object.entries(control.VENDOR_INFO);
  return `
    <div class="card">
      <h3>Add a device</h3>
      <p>
        <input id="dv-label" type="text" placeholder="label (e.g. Primary Pump)" style="width:30%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
        <select id="dv-vendor" onchange="dvVendorChanged()" style="padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
          ${vendors.map(([k, v]) => `<option value="${k}">${escape(v.name)}</option>`).join('')}
          <option value="generic">Generic</option>
        </select>
      </p>
      <div id="dv-vendor-fields">
        <p>
          <input id="dv-ip" type="text" placeholder="IP (192.168.x.x)" style="width:25%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
          <input id="dv-mac" type="text" placeholder="MAC (Wyze)" style="width:25%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px;display:none">
          <input id="dv-model" type="text" placeholder="Model (Wyze, e.g. WLPP1)" style="width:25%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px;display:none">
          <input id="dv-deviceId" type="text" placeholder="Device ID (Govee/Tuya)" style="width:35%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px;display:none">
          <input id="dv-sku" type="text" placeholder="SKU (Govee, e.g. H7141)" style="width:20%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px;display:none">
          <input id="dv-entityId" type="text" placeholder="Entity ID (HA, e.g. switch.pump)" style="width:35%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px;display:none">
        </p>
      </div>
      <p>
        <button onclick="dvAdd()">Add</button>
      </p>
    </div>`;
}

router.get('/devices', (_req, res) => {
  const list = devices.loadAll();
  const rows = list.map(d => {
    const cal = d.calibration;
    const credsOK = control.credsComplete(d.vendor);
    return `
      <tr data-id="${escape(d.id)}">
        <td>
          ${escape(d.label)}
          ${d.isPrimary ? pill('ok', 'primary') : ''}
          ${!credsOK ? pill('warn', 'creds missing') : ''}
        </td>
        <td><code>${escape(d.ip || d.mac || d.deviceId || '')}</code></td>
        <td>${escape(d.vendor)}</td>
        <td>${cal ? pill('ok', `${cal.secondsTo100}s → 100%`) : pill('warn', 'not calibrated')}</td>
        <td>
          <button onclick="dvTest('${escape(d.id)}', 'on')" ${!credsOK ? 'disabled' : ''}>Test On</button>
          <button onclick="dvTest('${escape(d.id)}', 'off')" ${!credsOK ? 'disabled' : ''}>Test Off</button>
          ${d.isPrimary ? '' : `<button onclick="dvMakePrimary('${escape(d.id)}')">Make primary</button>`}
          <button onclick="dvCalibrate('${escape(d.id)}')">Calibrate</button>
          <button onclick="dvRemove('${escape(d.id)}')">Remove</button>
        </td>
      </tr>
      <tr id="cal-${escape(d.id)}" style="display:none"><td colspan="5">
        <div class="card" style="margin:8px 0">
          <h3>Calibrate "${escape(d.label)}"</h3>
          <p class="muted">Live timing fires the actual pump on, waits for you to click when full, then shuts it off — saving the elapsed seconds as your seconds-to-100%.</p>
          <div class="grid-2">
            <div>
              <h4>Time it (drives the pump)</h4>
              <p><button class="btn-time-start" data-id="${escape(d.id)}" onclick="dvCalStart('${escape(d.id)}')" ${!credsOK ? 'disabled' : ''}>Start (pump ON)</button>
                 <span id="cal-elapsed-${escape(d.id)}" class="muted"></span></p>
              <p><button class="btn-time-stop" data-id="${escape(d.id)}" onclick="dvCalStop('${escape(d.id)}')" disabled>100% reached (pump OFF + save)</button></p>
            </div>
            <div>
              <h4>Manual entry</h4>
              <p>
                <input id="cal-manual-${escape(d.id)}" type="number" min="0.1" step="0.1" placeholder="seconds to 100%" style="width:60%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
                <button onclick="dvCalManual('${escape(d.id)}')">Save</button>
              </p>
            </div>
          </div>
        </div>
      </td></tr>
    `;
  }).join('');

  const body = `
    <h2>Device Discovery</h2>

    ${renderVendorCredentials()}

    ${renderHomeAssistant()}

    <div class="card">
      <h3>LAN scan</h3>
      <p class="muted">Lists devices in the local ARP cache. If yours doesn't show, ping it from the host once to populate.</p>
      <p><button onclick="dvScan()">Scan LAN</button></p>
      <div id="dv-scan-results"></div>
    </div>

    ${renderAddForm()}

    <div class="card">
      <h3>Saved devices ${list.length ? '' : '<span class="muted" style="font-size:0.9rem;font-weight:normal">— none yet</span>'}</h3>
      ${list.length ? `
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="text-align:left;border-bottom:1px solid #2a2f3a">
            <th style="padding:8px 0">Label</th><th>Identifier</th><th>Vendor</th><th>Calibration</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      ` : ''}
    </div>

    <div id="dv-msg" style="position:fixed;bottom:20px;right:20px;max-width:380px"></div>

    <script>
      const elapsedTimers = {};
      const VENDOR_FIELDS = {
        tapo:          ['ip'],
        kasa:          ['ip'],
        'kasa-klap':   ['ip'],
        wyze:          ['mac', 'model'],
        govee:         ['deviceId', 'sku'],
        tuya:          ['deviceId'],
        homeassistant: ['entityId'],
        generic:       ['ip'],
      };
      function flash(msg, cls) {
        const el = document.getElementById('dv-msg');
        el.innerHTML = '<div class="card" style="margin:0;border-color:' + (cls === 'bad' ? '#f08484' : cls === 'ok' ? '#6ddc9b' : '#f0c674') + '">' + msg + '</div>';
        setTimeout(() => { el.innerHTML = ''; }, 4000);
      }
      function dvVendorChanged() {
        const v = document.getElementById('dv-vendor').value;
        const visible = new Set(VENDOR_FIELDS[v] || []);
        for (const id of ['ip', 'mac', 'model', 'deviceId', 'sku', 'entityId']) {
          document.getElementById('dv-' + id).style.display = visible.has(id) ? '' : 'none';
        }
      }
      dvVendorChanged();
      async function dvScanKasa() {
        flash('broadcasting Kasa discovery (3s)…', 'warn');
        const r = await fetch('/api/devices/scan/kasa', { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'scan failed', 'bad');
        const items = d.results || [];
        const box = document.getElementById('kasa-scan-results');
        if (!items.length) {
          box.innerHTML = '<p class="muted">No Kasa devices responded. Make sure they\\'re on the same subnet and powered.</p>';
          return;
        }
        // Group strip outlets together for visual clarity
        const groups = new Map();
        for (const i of items) {
          if (i.error) { groups.set('err-' + i.ip, [i]); continue; }
          const key = i.isStrip ? ('strip-' + i.ip) : ('plug-' + i.ip);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(i);
        }
        const sections = [];
        for (const [key, rows] of groups) {
          if (key.startsWith('err-')) {
            sections.push('<p class="muted">' + rows[0].ip + ' — ' + rows[0].error + '</p>');
            continue;
          }
          const first = rows[0];
          if (first.isStrip) {
            sections.push(
              '<div style="margin-top:16px"><strong>Power strip: ' + esc(first.stripAlias) + '</strong> ' +
              '<span class="muted">' + esc(first.model) + ' · <code>' + esc(first.ip) + '</code> · ' + esc(first.mac) + '</span></div>' +
              '<table style="width:100%;margin:8px 0;border-collapse:collapse">' +
              '<thead><tr style="text-align:left;border-bottom:1px solid #2a2f3a"><th style="padding:6px 0">Outlet</th><th>State</th><th></th></tr></thead><tbody>' +
              rows.map(r => '<tr><td>' + esc(r.alias) + ' <span class="muted">(#' + r.childIndex + ')</span></td>' +
                '<td>' + (r.childState === 'on' ? '<span class="pill ok">on</span>' : '<span class="pill warn">off</span>') + '</td>' +
                '<td><button onclick="dvUseKasaChild(' + payload(r) + ')">Add this outlet</button></td></tr>').join('') +
              '</tbody></table>'
            );
          } else {
            sections.push(
              '<div style="margin-top:16px">' +
              '<strong>' + esc(first.alias || '(no alias)') + '</strong> ' +
              '<span class="muted">' + esc(first.model) + ' · <code>' + esc(first.ip) + '</code> · ' + esc(first.mac) + '</span> ' +
              '<button onclick="dvUseKasaPlug(' + payload(first) + ')">Add</button></div>'
            );
          }
        }
        box.innerHTML = sections.join('');
      }
      function esc(s) { return (s == null ? '' : String(s)).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])); }
      function payload(o) { return "'" + encodeURIComponent(JSON.stringify(o)) + "'"; }
      function setAddForm({ ip, mac, model, alias, childId, label }) {
        document.getElementById('dv-vendor').value = 'kasa';
        dvVendorChanged();
        document.getElementById('dv-ip').value = ip || '';
        document.getElementById('dv-mac').value = mac || '';
        document.getElementById('dv-model').value = model || '';
        let cf = document.getElementById('dv-childId');
        if (!cf) {
          cf = document.createElement('input');
          cf.type = 'hidden';
          cf.id = 'dv-childId';
          document.getElementById('dv-vendor-fields').appendChild(cf);
        }
        cf.value = childId || '';
        document.getElementById('dv-label').value = label || alias || 'Kasa ' + ip;
        document.getElementById('dv-label').focus();
        window.scrollTo({ top: document.getElementById('dv-label').getBoundingClientRect().top + window.scrollY - 100, behavior: 'smooth' });
      }
      function dvUseKasaPlug(encoded) {
        const o = JSON.parse(decodeURIComponent(encoded));
        setAddForm({ ip: o.ip, mac: o.mac, model: o.model, alias: o.alias, label: o.alias || 'Kasa ' + o.ip, childId: null });
      }
      function dvUseKasaChild(encoded) {
        const o = JSON.parse(decodeURIComponent(encoded));
        const composedLabel = (o.stripAlias ? o.stripAlias + ' — ' : '') + o.alias;
        setAddForm({ ip: o.ip, mac: o.mac, model: o.model, alias: composedLabel, label: composedLabel, childId: o.childId });
      }
      async function dvScan() {
        flash('scanning LAN…', 'warn');
        const r = await fetch('/api/devices/scan', { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'scan failed', 'bad');
        const items = d.results || [];
        const box = document.getElementById('dv-scan-results');
        if (!items.length) { box.innerHTML = '<p class="muted">No devices found.</p>'; return; }
        box.innerHTML = '<ul style="list-style:none;padding:0">' + items.map(i => {
          const hint = i.vendorHint ? '<span style="color:#6ddc9b">' + i.vendorHint + '?</span>' : '';
          return '<li style="padding:6px 0;border-bottom:1px solid #2a2f3a"><code>' + i.ip + '</code> ' +
            (i.mac ? '<span class="muted">' + i.mac + '</span> ' : '') + hint + ' ' +
            '<button style="float:right" onclick="dvUseScan(\\'' + i.ip + '\\', \\'' + (i.mac || '') + '\\', \\'' + (i.vendorHint || '') + '\\')">Use this</button></li>';
        }).join('') + '</ul>';
      }
      function dvUseScan(ip, mac, hint) {
        document.getElementById('dv-ip').value = ip;
        document.getElementById('dv-mac').value = mac;
        if (hint === 'tplink') {
          // owner chooses tapo vs kasa
          const vs = document.getElementById('dv-vendor');
          vs.value = 'tapo'; dvVendorChanged();
          flash('TP-Link OUI — switch to Kasa if this is a Kasa device', 'warn');
        } else if (hint && document.getElementById('dv-vendor').querySelector('option[value="' + hint + '"]')) {
          document.getElementById('dv-vendor').value = hint;
          dvVendorChanged();
        }
        document.getElementById('dv-label').focus();
      }
      async function dvAdd() {
        const payload = {
          label: document.getElementById('dv-label').value.trim(),
          vendor: document.getElementById('dv-vendor').value,
          ip: document.getElementById('dv-ip').value.trim(),
          mac: document.getElementById('dv-mac').value.trim(),
          model: document.getElementById('dv-model').value.trim(),
          deviceId: document.getElementById('dv-deviceId').value.trim(),
          sku: document.getElementById('dv-sku').value.trim(),
          entityId: document.getElementById('dv-entityId').value.trim(),
          childId: (document.getElementById('dv-childId') || {}).value || '',
        };
        if (!payload.label) return flash('label required', 'bad');
        const r = await fetch('/api/devices', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload) });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash('added', 'ok');
        setTimeout(() => location.reload(), 500);
      }
      async function dvRemove(id) {
        if (!confirm('Remove this device?')) return;
        const r = await fetch('/api/devices/' + id, { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash('removed', 'ok');
        setTimeout(() => location.reload(), 500);
      }
      async function dvMakePrimary(id) {
        const r = await fetch('/api/devices/' + id, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ isPrimary: true }) });
        if (!r.ok) { const d = await r.json(); return flash(d.error || 'failed', 'bad'); }
        flash('primary set', 'ok');
        setTimeout(() => location.reload(), 500);
      }
      async function dvTest(id, op) {
        const r = await fetch('/api/devices/' + id + '/' + (op === 'on' ? 'on' : 'off'), { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash('pump ' + op, 'ok');
      }
      function dvCalibrate(id) {
        const row = document.getElementById('cal-' + id);
        row.style.display = row.style.display === 'none' ? '' : 'none';
      }
      async function dvCalStart(id) {
        const startReq = await fetch('/api/devices/' + id + '/on', { method: 'POST' });
        if (!startReq.ok) { const d = await startReq.json(); return flash(d.error || 'failed to turn on', 'bad'); }
        const start = Date.now();
        const elapsedEl = document.getElementById('cal-elapsed-' + id);
        document.querySelector('.btn-time-start[data-id="' + id + '"]').disabled = true;
        document.querySelector('.btn-time-stop[data-id="' + id + '"]').disabled = false;
        elapsedTimers[id] = setInterval(() => {
          const s = ((Date.now() - start) / 1000).toFixed(1);
          elapsedEl.textContent = s + 's elapsed';
        }, 100);
        elapsedTimers[id + '-start'] = start;
        flash('pump on — click "100% reached" when full', 'ok');
      }
      async function dvCalStop(id) {
        const start = elapsedTimers[id + '-start'];
        clearInterval(elapsedTimers[id]);
        delete elapsedTimers[id];
        const seconds = (Date.now() - start) / 1000;
        await fetch('/api/devices/' + id + '/off', { method: 'POST' });
        await saveCalibration(id, seconds);
      }
      async function dvCalManual(id) {
        const v = parseFloat(document.getElementById('cal-manual-' + id).value);
        if (!v || v <= 0) return flash('enter a positive number of seconds', 'bad');
        await saveCalibration(id, v);
      }
      async function saveCalibration(id, seconds) {
        const r = await fetch('/api/devices/' + id + '/calibrate', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ secondsTo100: seconds }) });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash('calibrated: ' + seconds.toFixed(1) + 's to 100%', 'ok');
        setTimeout(() => location.reload(), 500);
      }
      async function dvSaveCreds(vendor) {
        const inputs = document.querySelectorAll('input[data-vendor="' + vendor + '"]');
        const creds = {};
        for (const i of inputs) {
          const v = i.value;
          if (v && v !== '••••••••') creds[i.dataset.field] = v;
        }
        const r = await fetch('/api/vendors/' + vendor + '/creds', { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify(creds) });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash(vendor + ' credentials saved', 'ok');
        setTimeout(() => location.reload(), 500);
      }
      async function haSave() {
        const baseUrl = document.getElementById('ha-base').value.trim();
        const tokenRaw = document.getElementById('ha-token').value;
        const body = { baseUrl };
        if (tokenRaw && tokenRaw !== '••••••••') body.token = tokenRaw;
        const r = await fetch('/api/devices/ha/save', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
        const d = await r.json();
        document.getElementById('ha-status').textContent = (!r.ok || d.error) ? ('error: ' + (d.error || '?')) : 'saved';
        if (r.ok && !d.error) setTimeout(() => location.reload(), 600);
      }
      async function haTest() {
        const s = document.getElementById('ha-status');
        s.textContent = 'testing…';
        const r = await fetch('/api/devices/ha/test', { method: 'POST' });
        const d = await r.json();
        s.textContent = (!r.ok || d.error) ? ('error: ' + (d.error || '?')) : (d.ok ? 'ok' : 'failed');
      }
    </script>
  `;
  res.type('html').send(ownerLayout({ title: 'Device Discovery', active: 'devices', body }));
});

// --- API ---

router.post('/api/devices/scan/kasa', async (_req, res) => {
  try {
    const results = await devices.scanKasa(3);
    res.json({ results });
  } catch (e) {
    logger.error('kasa scan failed', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/devices/scan', async (_req, res) => {
  try {
    const results = await devices.scanLan();
    const hinted = results.map(r => ({ ...r, vendorHint: control.hintVendorFromMac(r.mac) }));
    res.json({ results: hinted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/devices', (req, res) => {
  try {
    const dev = devices.add(req.body || {});
    res.json({ device: dev });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/api/devices/:id', (req, res) => {
  try {
    const dev = devices.update(req.params.id, req.body || {});
    res.json({ device: dev });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/api/devices/:id', (req, res) => {
  try {
    devices.remove(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/devices/:id/calibrate', (req, res) => {
  try {
    const seconds = parseFloat(req.body?.secondsTo100);
    const dev = devices.saveCalibration(req.params.id, seconds);
    res.json({ device: dev });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/devices/:id/on', async (req, res) => {
  const dev = devices.get(req.params.id);
  if (!dev) return res.status(404).json({ error: 'not found' });
  try {
    await control.turnOn(dev);
    res.json({ ok: true });
  } catch (e) {
    logger.error(`turnOn failed for ${dev.label}: ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/devices/:id/off', async (req, res) => {
  const dev = devices.get(req.params.id);
  if (!dev) return res.status(404).json({ error: 'not found' });
  try {
    await control.turnOff(dev);
    res.json({ ok: true });
  } catch (e) {
    logger.error(`turnOff failed for ${dev.label}: ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});

router.patch('/api/vendors/:vendor/creds', (req, res) => {
  const vendor = req.params.vendor;
  if (!control.VENDOR_INFO[vendor]) return res.status(400).json({ error: 'unknown vendor' });
  const cfg = config.load();
  const existing = (cfg.vendors && cfg.vendors[vendor]) || {};
  const updated = { ...existing, ...(req.body || {}) };
  config.save({ vendors: { [vendor]: updated } });
  res.json({ message: 'saved' });
});

router.post('/api/devices/ha/save', (req, res) => {
  const baseUrl = (req.body?.baseUrl || '').trim();
  const tokenIn = (req.body?.token || '').trim();
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
    return res.status(400).json({ error: 'baseUrl must start with http:// or https://' });
  }
  const cfg = config.load();
  const existing = cfg.vendors?.homeassistant || {};
  const next = {
    baseUrl: baseUrl || existing.baseUrl || '',
    token: tokenIn || existing.token || '',
  };
  config.save({ vendors: { homeassistant: next } });
  ha.setCredentials(next.baseUrl, next.token);
  res.json({ message: 'saved' });
});

router.post('/api/devices/ha/test', async (_req, res) => {
  const cfg = config.load();
  const c = cfg.vendors?.homeassistant || {};
  if (!c.baseUrl || !c.token) return res.status(400).json({ error: 'baseUrl + token required (save first)' });
  ha.setCredentials(c.baseUrl, c.token);
  try {
    const ok = await ha.testConnection();
    res.json({ ok });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
