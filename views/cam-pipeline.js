// Browser-side camera processing pipeline. Inlined on Chat/Webcam (for the
// configuration UI) and on Launchpad (where the broadcast actually originates),
// so a single canvas-driven path applies to both the preview and what visitors
// see over WebRTC.
//
// All software settings live in localStorage so they survive reloads and so
// each browser/machine has its own tuning. The pipeline reads the current
// settings every frame, so slider changes feel instant without any plumbing.

function camPipelineJs() {
  return `
  (function () {
    if (window.PDCam) return;
    const KEY_ENABLED = 'pd-cam-sw:enabled';
    const KEY_PREFIX  = 'pd-cam-sw:';
    // Each entry: [key, default, min, max, step]. Range only - bools have their own key.
    const SETTINGS_SPEC = [
      ['zoom',       1.0, 1.0, 4.0, 0.05],
      ['panX',       0.0, -1.0, 1.0, 0.02],
      ['panY',       0.0, -1.0, 1.0, 0.02],
      ['hue',        0,   0,   360, 1],
      ['brightness', 1.0, 0.4, 2.0, 0.02],
      ['contrast',   1.0, 0.4, 2.0, 0.02],
      ['saturate',   1.0, 0.0, 2.5, 0.02],
      ['mirror',     0,   0,   1,   1],   // 0|1 - flip horizontally
    ];
    const DEFAULTS = Object.fromEntries(SETTINGS_SPEC.map(s => [s[0], s[1]]));

    function isEnabled() { return localStorage.getItem(KEY_ENABLED) === '1'; }
    function setEnabled(v) { localStorage.setItem(KEY_ENABLED, v ? '1' : '0'); }
    function get(key) {
      const raw = localStorage.getItem(KEY_PREFIX + key);
      if (raw == null) return DEFAULTS[key];
      const n = Number(raw);
      return Number.isFinite(n) ? n : DEFAULTS[key];
    }
    function set(key, val) {
      if (val == null || val === DEFAULTS[key]) localStorage.removeItem(KEY_PREFIX + key);
      else localStorage.setItem(KEY_PREFIX + key, String(val));
    }
    function resetAll() {
      for (const [k] of SETTINGS_SPEC) localStorage.removeItem(KEY_PREFIX + k);
    }

    // Wrap a raw MediaStream in a canvas pipeline. Returns { stream, stop }.
    // The returned stream contains the processed video track plus any audio
    // tracks from the source stream (untouched). Settings are re-read every
    // frame, so changes apply immediately without restarting.
    function startPipeline(srcStream) {
      const srcVideo = document.createElement('video');
      srcVideo.srcObject = srcStream;
      srcVideo.muted = true;
      srcVideo.playsInline = true;
      srcVideo.autoplay = true;
      const playPromise = srcVideo.play().catch(() => {});

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      let raf = null;
      let running = true;

      function loop() {
        if (!running) return;
        const sw = srcVideo.videoWidth, sh = srcVideo.videoHeight;
        if (sw && sh) {
          if (canvas.width !== sw) canvas.width = sw;
          if (canvas.height !== sh) canvas.height = sh;

          const zoom = Math.max(1, get('zoom'));
          const panX = Math.max(-1, Math.min(1, get('panX')));
          const panY = Math.max(-1, Math.min(1, get('panY')));
          const hue  = get('hue');
          const br   = get('brightness');
          const ct   = get('contrast');
          const sat  = get('saturate');
          const mir  = get('mirror') ? -1 : 1;

          const cropW = sw / zoom;
          const cropH = sh / zoom;
          const sx = (sw - cropW) * ((panX + 1) / 2);
          const sy = (sh - cropH) * ((panY + 1) / 2);

          // Build the filter string only when something is non-default.
          const parts = [];
          if (br !== 1)  parts.push('brightness(' + br + ')');
          if (ct !== 1)  parts.push('contrast(' + ct + ')');
          if (sat !== 1) parts.push('saturate(' + sat + ')');
          if (hue !== 0) parts.push('hue-rotate(' + hue + 'deg)');
          ctx.filter = parts.length ? parts.join(' ') : 'none';

          ctx.save();
          if (mir === -1) { ctx.translate(sw, 0); ctx.scale(-1, 1); }
          ctx.drawImage(srcVideo, sx, sy, cropW, cropH, 0, 0, sw, sh);
          ctx.restore();
        }
        raf = requestAnimationFrame(loop);
      }
      loop();

      const outStream = canvas.captureStream(30);
      // Preserve any audio from the source — only the video track is processed.
      for (const at of srcStream.getAudioTracks()) outStream.addTrack(at);

      return {
        stream: outStream,
        srcStream,
        stop() {
          running = false;
          if (raf) cancelAnimationFrame(raf);
          try { srcVideo.srcObject = null; } catch {}
          for (const t of outStream.getVideoTracks()) { try { t.stop(); } catch {} }
        },
      };
    }

    // VU meter helper — analyses the first audio track in a stream and
    // updates fillEl.style.width to a 0–100% bar representing the RMS level.
    // Returns a stop() function that tears down the AudioContext.
    function startVuMeter(stream, fillEl) {
      const at = stream && stream.getAudioTracks && stream.getAudioTracks()[0];
      if (!at) { if (fillEl) fillEl.style.width = '0%'; return function () {}; }
      let raf = null;
      let ctx, src, an;
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        // Chrome/Safari start the AudioContext suspended when it's created
        // outside a synchronous user-gesture callback (awaiting getUserMedia
        // breaks the gesture chain). resume() is allowed once a gesture has
        // happened earlier in the same tab, which is always true here.
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
        src = ctx.createMediaStreamSource(stream);
        an = ctx.createAnalyser();
        an.fftSize = 256;
        // Some browsers require the analyser to be connected to the
        // destination for the source to actually produce samples. Route
        // through a gain node at 0 so we don't echo the mic to the speakers.
        const sink = ctx.createGain();
        sink.gain.value = 0;
        src.connect(an);
        an.connect(sink);
        sink.connect(ctx.destination);
      } catch (e) {
        console.warn('VU meter init failed', e);
        return function () {};
      }
      const buf = new Uint8Array(an.frequencyBinCount);
      function loop() {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        const pct = Math.min(100, rms * 200);
        if (fillEl) fillEl.style.width = pct.toFixed(1) + '%';
        raf = requestAnimationFrame(loop);
      }
      loop();
      return function stop() {
        if (raf) cancelAnimationFrame(raf);
        try { src.disconnect(); } catch {}
        try { ctx.close(); } catch {}
      };
    }

    window.PDCam = {
      SETTINGS_SPEC, DEFAULTS,
      isEnabled, setEnabled, get, set, resetAll,
      startPipeline, startVuMeter,
    };
  })();
  `;
}

module.exports = { camPipelineJs };
