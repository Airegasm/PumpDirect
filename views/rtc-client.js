// Shared WebRTC client. Returns a JS string to inline in a <script> tag.
// Both Launchpad (owner) and Visitor pages use it. Each page supplies:
//   getWs()   — returns the WebSocket already connected to /ws/owner or /ws/visitor
//   onRemoteStream(email, stream) — render the remote stream in a tile
//   onRemoteGone(email) — remove that tile
//   getLocalStream() — return current MediaStream we're publishing (or null)
function rtcClientJs({ myEmail }) {
  return `
    window.__rtc = (function() {
      const MY_EMAIL = ${JSON.stringify(myEmail)};
      const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
      const pcs = new Map();
      const knownPeers = new Set();
      const nicknames = new Map();   // email -> nickname
      const owners = new Set();      // emails that are isOwner
      let sendSig = () => {};
      let getLocalStream = () => null;
      let onRemoteStream = () => {};
      let onRemoteGone = () => {};

      function nicknameOf(email) { return nicknames.get(email) || (String(email).split('@')[0]); }
      function isOwnerOf(email) { return owners.has(email); }

      function init(opts) {
        sendSig = opts.sendSig;
        getLocalStream = opts.getLocalStream;
        onRemoteStream = opts.onRemoteStream;
        onRemoteGone = opts.onRemoteGone;
      }

      function getPc(remote) {
        let pc = pcs.get(remote);
        if (pc) return pc;
        pc = new RTCPeerConnection(RTC_CFG);
        pc.onicecandidate = e => { if (e.candidate) sendSig({ type: 'webrtc-ice', toEmail: remote, candidate: e.candidate }); };
        pc.ontrack = e => { if (e.streams && e.streams[0]) onRemoteStream(remote, e.streams[0], nicknameOf(remote), isOwnerOf(remote)); };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
            closePc(remote);
          }
        };
        pcs.set(remote, pc);
        return pc;
      }

      function closePc(remote) {
        const pc = pcs.get(remote);
        if (pc) try { pc.close(); } catch {}
        pcs.delete(remote);
        onRemoteGone(remote);
      }

      async function publishTo(remote) {
        if (remote === MY_EMAIL) return;
        const stream = getLocalStream();
        if (!stream) return;
        const pc = getPc(remote);
        for (const track of stream.getTracks()) {
          const has = pc.getSenders().some(s => s.track === track);
          if (!has) pc.addTrack(track, stream);
        }
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendSig({ type: 'webrtc-offer', toEmail: remote, sdp: pc.localDescription });
        } catch (e) { console.warn('publishTo failed', e); }
      }

      async function publishToAll() {
        for (const email of knownPeers) await publishTo(email);
      }

      async function handleOffer(msg) {
        const pc = getPc(msg.fromEmail);
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const stream = getLocalStream();
        if (stream) {
          for (const track of stream.getTracks()) {
            const has = pc.getSenders().some(s => s.track === track);
            if (!has) pc.addTrack(track, stream);
          }
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSig({ type: 'webrtc-answer', toEmail: msg.fromEmail, sdp: pc.localDescription });
      }

      async function handleAnswer(msg) {
        const pc = pcs.get(msg.fromEmail);
        if (pc) try { await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp)); } catch {}
      }

      async function handleIce(msg) {
        const pc = pcs.get(msg.fromEmail);
        if (pc && msg.candidate) try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
      }

      function onSignalingMsg(msg) {
        if (msg.type === 'hello') {
          (msg.peers || []).forEach(p => {
            if (p.email !== MY_EMAIL) knownPeers.add(p.email);
            if (p.nickname) nicknames.set(p.email, p.nickname);
            if (p.isOwner) owners.add(p.email);
          });
          if (msg.nickname) nicknames.set(msg.email, msg.nickname);
          if (msg.isOwner) owners.add(msg.email);
        } else if (msg.type === 'peer-joined') {
          if (msg.nickname) nicknames.set(msg.email, msg.nickname);
          if (msg.isOwner) owners.add(msg.email);
          if (msg.email !== MY_EMAIL) {
            knownPeers.add(msg.email);
            if (getLocalStream()) publishTo(msg.email);
          }
        } else if (msg.type === 'peer-left') {
          owners.delete(msg.email);
          knownPeers.delete(msg.email);
          closePc(msg.email);
        } else if (msg.type === 'webrtc-offer') handleOffer(msg);
        else if (msg.type === 'webrtc-answer') handleAnswer(msg);
        else if (msg.type === 'webrtc-ice') handleIce(msg);
      }

      function tearDownAll() {
        for (const remote of Array.from(pcs.keys())) closePc(remote);
      }

      return { init, onSignalingMsg, publishToAll, publishTo, tearDownAll, knownPeers };
    })();
  `;
}

module.exports = { rtcClientJs };
