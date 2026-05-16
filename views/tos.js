const { fetchShimJs } = require('../utils/csrf');

// Bump TOS_VERSION whenever the text changes — owner is forced to re-accept on next launch.
const TOS_VERSION = 1;
const TOS_EFFECTIVE = 'May 2026';

function tosBody() {
  return `
<h1>PumpDirect — Terms of Service</h1>
<p><strong>Version ${TOS_VERSION} · Effective ${TOS_EFFECTIVE}</strong></p>

<h2>1. Nature of the Software</h2>
<p>PumpDirect is <strong>self-hosted, peer-to-peer software</strong> distributed as source code. There is no central operator and no central server. You — the person running the Software on your own hardware — are the <strong>Operator</strong> of your instance. By installing, running, or using PumpDirect ("the Software") you acknowledge that you have read, understood, and agree to be bound by these Terms. If you do not agree, do not use the Software.</p>

<h2>2. Disclaimer of Liability</h2>
<p><strong>The authors, distributors, contributors, and affiliates of PumpDirect (collectively "Authors") are not liable for any injury, harm, death, damage, legal consequence, fine, or loss of any kind</strong> resulting from the use, misuse, or distribution of this Software, regardless of cause. The Software is provided <strong>"AS IS"</strong>, without warranty of any kind, express or implied.</p>

<h2>3. Operator Responsibility — Age &amp; Consent of Every Participant</h2>
<p>You, as the Operator of a PumpDirect instance, are <strong>solely and entirely responsible</strong> for ensuring that:</p>
<ul>
  <li>You are of legal age to use the Software in your jurisdiction (<strong>at least 18, or 21 where local, state, provincial, or national law requires it</strong>).</li>
  <li><strong>Every guest, visitor, controller, or other person to whom you grant access</strong> to your PumpDirect instance is also of legal age in their own jurisdiction (<strong>at least 18, or 21 where applicable</strong>).</li>
  <li>You have obtained informed, freely-given, sober consent from every participant before any activity.</li>
  <li>You verify the identity and age of each guest through means appropriate to applicable law.</li>
</ul>
<p>The Authors <strong>cannot and will not</strong> verify the age, identity, or consent of users connecting to your instance. That responsibility rests entirely with you as the Operator.</p>

<h2>4. Assumption of Risk</h2>
<p>You acknowledge that activities the Software is designed to control carry <strong>inherent physical risks</strong>, including but not limited to injury, pain, discomfort, equipment failure, electrical or water hazard, or other adverse effects. You voluntarily assume all such risks for yourself and accept that you, not the Authors, are responsible for ensuring participants understand and accept those risks.</p>

<h2>5. Safety Warning — Hardware Disconnect Required</h2>
<p><strong>The E-STOP button and the "Disable device control at 100%" setting in this Software MUST NOT be relied upon as a primary safety mechanism.</strong> You must ALWAYS have a hardware disconnect (an inline shutoff valve, a physical power switch, or an accessible plug) within immediate arm's reach during any session. Software can crash, freeze, lose its network, mis-route commands, or experience delays. Only a hardware disconnect provides reliable immediate safety.</p>

<h2>6. Prohibited Conduct</h2>
<p>The Authors <strong>do not condone, support, or encourage</strong> any use that may cause bodily harm, injury, death, or violate any applicable law. Specifically prohibited uses include but are not limited to:</p>
<ul>
  <li>Providing access to anyone under the legal age in any applicable jurisdiction.</li>
  <li>Operating without consent from all participants.</li>
  <li>Operating while impaired by alcohol, drugs, or medication.</li>
  <li>Any use that violates applicable law in your jurisdiction or that of any participant.</li>
</ul>

<h2>7. No Medical Advice</h2>
<p>The Software does not provide medical advice. Any text shown — including milestone announcements, chat content, and visitor messages — is for entertainment purposes only and is not a substitute for qualified medical advice. Consult a healthcare professional regarding any health concern.</p>

<h2>8. Indemnification</h2>
<p>You agree to indemnify, defend, and hold harmless the Authors and all contributors from any claims, damages, losses, fines, penalties, or expenses arising from your use, operation, or distribution of the Software, including any harm to guests or third parties.</p>

<h2>9. Modifications to These Terms</h2>
<p>The Authors may revise these Terms. When revised, the version number above changes and you will be prompted to accept the new version before the Software unlocks.</p>

<h2>10. Governing Law</h2>
<p>These Terms shall be governed by applicable law in your jurisdiction, without regard to conflict-of-law principles.</p>

<hr>
<p><strong>BY CLICKING "I AGREE", YOU CONFIRM THAT YOU ARE THE OPERATOR OF THIS INSTANCE AND THAT YOU ACCEPT FULL RESPONSIBILITY FOR VERIFYING THE LEGAL AGE AND CONSENT OF EVERY PERSON TO WHOM YOU GRANT ACCESS, AS WELL AS FOR THEIR SAFETY. YOU ACKNOWLEDGE THAT THE AUTHORS ARE NOT LIABLE FOR ANY MISUSE OF THIS SOFTWARE.</strong></p>
`;
}

function renderTosPage({ updateInfo }) {
  const updateBlock = renderUpdateBlock(updateInfo);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PumpDirect — Terms of Service</title>
<style>
  :root { color-scheme: dark; font-size: 18px; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, sans-serif; background: #0f1115; color: #e8e8e8; line-height: 1.5; min-height: 100vh; padding: 24px 16px; }
  .tos-wrap { max-width: 820px; margin: 0 auto; }
  .card { background: #161922; border: 1px solid #2a2f3a; border-radius: 12px; padding: 28px 32px; margin-bottom: 20px; }
  h1 { font-size: 1.8rem; margin: 0 0 14px; }
  h2 { font-size: 1.15rem; margin: 22px 0 8px; color: #e8e8e8; }
  p, li { font-size: 1rem; line-height: 1.55; }
  ul { padding-left: 1.2em; }
  hr { border: 0; border-top: 1px solid #2a2f3a; margin: 24px 0; }
  .accept-bar { background: #161922; border: 1px solid #2a2f3a; border-radius: 12px; padding: 18px 24px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .accept-bar label { font-size: 1rem; flex: 1; }
  button { background: #2a6df4; color: #fff; border: 0; border-radius: 8px; padding: 12px 24px; font-size: 1rem; font-family: inherit; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .update { background: #161922; border: 1px solid #2a2f3a; border-radius: 10px; padding: 14px 18px; margin-bottom: 16px; display: flex; align-items: center; gap: 12px; }
  .update.behind { border-color: #f0c674; }
  .update.error { border-color: #4a3413; }
  .update .label { color: #7a8597; font-size: 0.9rem; }
  .update strong { color: #f0c674; }
  .update code { background: #0a0c10; padding: 2px 8px; border-radius: 4px; font-size: 0.9rem; }
</style></head>
<body>
<div class="tos-wrap">
  ${updateBlock}
  <div class="card">${tosBody()}</div>
  <div class="accept-bar">
    <label><input id="confirm-age" type="checkbox" onchange="document.getElementById('accept').disabled = !this.checked"> I am of legal age and I have read and agree to these Terms.</label>
    <button id="accept" disabled onclick="acceptTos()">I Agree</button>
  </div>
</div>
<script>${fetchShimJs()}</script>
<script>
  async function acceptTos() {
    const btn = document.getElementById('accept');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    function reset() { btn.disabled = false; btn.textContent = 'I Agree'; }
    try {
      const r = await fetch('/api/owner/tos/accept', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ version: ${TOS_VERSION} }) });
      let d = {};
      try { d = await r.json(); } catch {}
      if (!r.ok || d.error) {
        alert(d.error || ('Save failed (HTTP ' + r.status + '). Check the PumpDirect terminal window for the error.'));
        reset();
        return;
      }
      location.href = '/';
    } catch (e) {
      alert('Could not reach PumpDirect (' + e.message + '). Make sure the app is still running in its terminal window, then try again.');
      reset();
    }
  }
</script>
</body></html>`;
}

function renderUpdateBlock(info) {
  if (!info) return '';
  if (!info.isGitRepo) {
    return `<div class="update"><span class="label">Version:</span> <span>not running from a git checkout — manual update only.</span></div>`;
  }
  if (info.behind > 0) {
    return `<div class="update behind">
      <span><strong>Update available</strong> — you are ${info.behind} commit${info.behind === 1 ? '' : 's'} behind <code>origin/main</code>.</span>
      <span class="label">current: <code>${info.currentSha}</code></span>
    </div>`;
  }
  if (info.error) {
    return `<div class="update error"><span class="label">Update check failed:</span> <code>${escapeText(info.error)}</code> · current: <code>${escapeText(info.currentSha || '')}</code></div>`;
  }
  return `<div class="update"><span class="label">Up to date</span> · <code>${escapeText(info.currentSha || '')}</code></div>`;
}

function escapeText(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

module.exports = { TOS_VERSION, renderTosPage, tosBody };
