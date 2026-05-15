// Shared client-side overlay renderer. Both Launchpad (owner) and Visitor pages
// inline this string into a <script> tag. The page must already have:
//   * /assets/vendor/lottie.min.js loaded (synchronously, or before the overlay
//     handler is called)
//   * an element with id="overlay-stage" inside #session-stage
//   * a single global `lottie` symbol from the loaded player
//
// Public surface: `renderOverlay(msg)` — call it on any WS message of type
// 'overlay'. The msg shape depends on `msg.kind`; current kinds:
//   - 'dice-roll' { dice:[1..6], mode, total, durationMs, by }

function overlayJs() {
  return `
    function _mountOverlay(html, durationMs) {
      const stage = document.getElementById('overlay-stage');
      if (!stage) return;
      stage.innerHTML = html;
      stage.classList.add('active');
      clearTimeout(window.__overlayTimer);
      window.__overlayTimer = setTimeout(() => {
        stage.classList.remove('active');
        stage.innerHTML = '';
      }, durationMs || 2500);
    }
    function _diceLayoutClass(n) {
      // cluster style — 1 centered, 2 row, 3 row, 4 2x2, 5 honeycomb, 6 3x2
      if (n <= 1) return 'dice-1';
      if (n === 2) return 'dice-2';
      if (n === 3) return 'dice-3';
      if (n === 4) return 'dice-4';
      if (n === 5) return 'dice-5';
      return 'dice-6';
    }
    function renderOverlay(msg) {
      if (!msg) return;
      if (msg.kind === 'dice-roll') return _renderDiceRoll(msg);
      if (msg.kind === 'prize-wheel') return _renderPrizeWheel(msg);
      if (msg.kind === 'lottie-overlay') return _renderLottieOverlay(msg);
      if (msg.kind === 'video-overlay') return _renderVideoOverlay(msg);
      if (msg.kind === 'action-flash') return _renderActionFlash(msg);
      if (msg.kind === 'play-sound') return _playSound(msg);
      if (msg.kind === 'session-ending') return _renderSessionEnding(msg);
    }
    // ---- prize-wheel ----
    function _wedgePath(cx, cy, r, startDeg, endDeg) {
      const toRad = (d) => (d - 90) * Math.PI / 180;
      const x1 = cx + r * Math.cos(toRad(startDeg));
      const y1 = cy + r * Math.sin(toRad(startDeg));
      const x2 = cx + r * Math.cos(toRad(endDeg));
      const y2 = cy + r * Math.sin(toRad(endDeg));
      const large = (endDeg - startDeg) > 180 ? 1 : 0;
      return 'M' + cx + ',' + cy + ' L' + x1.toFixed(2) + ',' + y1.toFixed(2)
        + ' A' + r + ',' + r + ' 0 ' + large + ',1 ' + x2.toFixed(2) + ',' + y2.toFixed(2) + ' Z';
    }
    function _buildWheelSvg(sections) {
      // CSS-only transform on .wheel-rot. Do NOT also set the SVG transform
      // attribute — having both fights the CSS transition and the wheel just
      // snaps. transform-box + transform-origin pin the rotation pivot to the
      // wheel's geometric center cross-browser (Safari 12+ included).
      const N = sections.length;
      const slice = 360 / N;
      const R = 90;
      const wedges = sections.map((s, i) => {
        const a0 = i * slice;
        const a1 = (i + 1) * slice;
        return '<path d="' + _wedgePath(100, 100, R, a0, a1) + '" fill="' + (s.color || '#7b3fd6') + '" stroke="rgba(0,0,0,0.25)" stroke-width="0.6"/>';
      }).join('');
      const labels = sections.map((s, i) => {
        // Two-stage rotation: the parent <g> rotates around the wheel center to
        // line up with this wedge; the <text> then rotates -90° about its own
        // anchor so it reads radially (bottom near center, top near edge) —
        // makes long labels fit in narrow wedges when N is large.
        const rotation = i * slice + slice / 2;
        const tx = 100, ty = 100 - R * 0.55;
        const safe = String(s.label || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
        const fontSize = N <= 4 ? 12 : N <= 6 ? 10 : N <= 8 ? 8.5 : 7.5;
        return '<g transform="rotate(' + rotation.toFixed(2) + ' 100 100)">'
          + '<text x="' + tx + '" y="' + ty + '" text-anchor="middle" dominant-baseline="middle" '
          + 'transform="rotate(-90 ' + tx + ' ' + ty + ')" '
          + 'fill="#fff" font-weight="700" font-size="' + fontSize + '" '
          + 'style="paint-order:stroke;stroke:rgba(0,0,0,0.55);stroke-width:1.4px">'
          + safe + '</text></g>';
      }).join('');
      return '<svg viewBox="0 0 200 220" xmlns="http://www.w3.org/2000/svg">'
        + '<g class="wheel-rot">'
        + wedges
        + '<circle cx="100" cy="100" r="' + R + '" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="1.2"/>'
        + labels
        + '<circle cx="100" cy="100" r="6" fill="#fff" stroke="rgba(0,0,0,0.5)" stroke-width="1"/>'
        + '</g>'
        + '<polygon points="100,4 90,22 110,22" fill="#fff" stroke="rgba(0,0,0,0.6)" stroke-width="1"/>'
        + '</svg>';
    }
    // Phase 1: stationary mount + Spin button. The spinner sees the button;
    // everyone else sees the wheel paused waiting for the spinner.
    // Single-shot wheel renderer: mounts the wheel and immediately spins the
    // chain. No Spin button — the wheel comes up rolling so visitors don't
    // wait on a click. The brief "stationary" mount + animation start are
    // separated by one rAF so the CSS transition kicks in cleanly.
    function _renderPrizeWheel(msg) {
      const chain = Array.isArray(msg.chain) ? msg.chain : [];
      if (!chain.length) return;
      const by = String(msg.by || 'someone').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      const wheelName = String(msg.wheel?.name || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      const banner = '<div class="dice-banner" id="wheel-banner">🎡 ' + by + ' — ' + wheelName + '</div>';
      const spinPerStep = msg.durationMsPerSpin || 4500;
      const totalMs = chain.length * spinPerStep + 800;
      _mountOverlay(
        '<div class="wheel-container">'
        +   '<div class="wheel-stage">' + _buildWheelSvg(chain[0].sections) + '</div>'
        + '</div>'
        + banner,
        totalMs
      );
      const stage = document.getElementById('overlay-stage');
      const wheelEl = stage && stage.querySelector('.wheel-stage');
      if (!wheelEl) return;
      const animMs = Math.max(800, spinPerStep - 500);

      let cumulativeRot = 0;
      function spinTo(targetIndex, totalSlices, isLast) {
        const sliceCenter = (targetIndex + 0.5) * (360 / totalSlices);
        cumulativeRot += 4 * 360 + 360 - sliceCenter;
        const rot = wheelEl.querySelector('.wheel-rot');
        if (!rot) return;
        // Force a reflow so the freshly-applied CSS picks up the next transform
        // with a transition rather than snapping.
        rot.style.transition = 'none';
        rot.getBoundingClientRect();
        rot.style.transition = 'transform ' + animMs + 'ms cubic-bezier(.18,.7,.12,1)';
        rot.style.transform = 'rotate(' + cumulativeRot.toFixed(2) + 'deg)';
        if (isLast) {
          setTimeout(() => {
            const b = document.getElementById('wheel-banner');
            if (b) b.textContent = '🎡 ' + (msg.finalLabel || '—');
          }, animMs);
        }
      }
      let cursor = 0;
      function nextStep() {
        if (cursor >= chain.length) return;
        const entry = chain[cursor];
        if (cursor > 0) {
          // Subsequent spin in a chain — re-draw with the new section order so
          // randomized wheels look different each spin.
          wheelEl.innerHTML = _buildWheelSvg(entry.sections);
          cumulativeRot = 0;
        }
        const isLast = cursor === chain.length - 1;
        requestAnimationFrame(() => spinTo(entry.targetIndex, entry.sections.length, isLast));
        cursor++;
        if (cursor < chain.length) setTimeout(nextStep, spinPerStep);
      }
      nextStep();
    }

    function _renderLottieOverlay(msg) {
      // Anchor the lottie to the host cam TILE's bounds — captured at mount
      // time so the lottie keeps its size + position even after the tile
      // underneath gets destroyed by turn-off-host-cam. xPct/yPct/widthPct
      // are percentages of the tile, so 100% width = exactly the cam width
      // (matches the editor's preview rectangle).
      const safe = String(msg.path || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      if (!safe) return;
      const stage = document.getElementById('trigger-fx-stage');
      if (!stage) return;

      // Target the host cam tile (local-tile on Launchpad, rt-<owner> on
      // Visitor). Falls back to cam-owner-slot if the tile isn't mounted yet
      // (e.g. visitor before host cam comes online).
      const targetFn = window.__textOverlayTarget;
      const tile = typeof targetFn === 'function' ? targetFn() : null;
      const ref = tile || document.getElementById('cam-owner-slot');
      const grid = stage.parentElement;
      if (!ref || !grid) return;
      const refRect = ref.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      let left = refRect.left - gridRect.left;
      let top  = refRect.top - gridRect.top;
      let width = refRect.width;
      let height = refRect.height;
      // Fallback bounds if the reference happens to be collapsed.
      if (width <= 1 || height <= 1) {
        width = Math.min(gridRect.width || 400, 480);
        height = width;
        left = (gridRect.width - width) / 2;
        top = 8;
      }

      const xPct = Math.max(0, Math.min(100, Number(msg.xPct != null ? msg.xPct : 50)));
      const yPct = Math.max(0, Math.min(100, Number(msg.yPct != null ? msg.yPct : 50)));
      const wPct = Math.max(5, Math.min(100, Number(msg.widthPct != null ? msg.widthPct : 40)));
      stage.innerHTML = '<div class="lottie-trigger-stage" style="position:absolute;'
        + 'left:' + left + 'px;top:' + top + 'px;width:' + width + 'px;height:' + height + 'px">'
        + '<div class="lottie-trigger-slot" style="left:' + xPct + '%;top:' + yPct + '%;width:' + wPct + '%"></div>'
        + '</div>';

      const freeze = !!msg.freezeLastFrame;
      const dur = Math.max(200, Number(msg.durationMs) || 2500);
      clearTimeout(window.__triggerFxTimer);
      if (!freeze) {
        window.__triggerFxTimer = setTimeout(() => { stage.innerHTML = ''; }, dur);
      }
      const slot = stage.querySelector('.lottie-trigger-slot');
      if (!slot) return;
      if (typeof window.lottie !== 'undefined') {
        try {
          window.lottie.loadAnimation({
            container: slot,
            path: '/assets/triggers/lottie/' + safe,
            renderer: 'svg',
            loop: false,
            autoplay: true,
          });
        } catch (e) { slot.textContent = '(lottie load failed)'; }
      } else {
        slot.textContent = msg.path;
      }
    }
    function _renderActionFlash(msg) {
      // Floating notice anchored at the top-center of the host cam tile;
      // holds for a moment, then rises while fading. When flashes arrive in
      // quick succession, each new one is offset downward into a vertical
      // queue so they don't pile up on top of each other — as the older
      // entries rise out of their slot the queue compacts naturally.
      const text = String(msg.text || '');
      if (!text) return;
      const stage = document.getElementById('action-flash-stage');
      if (!stage) return;
      // Total visible-on-screen lifetime in ms; bumped from 2.4s so the
      // post-animation result pills (dice / wheel) have time to read.
      const LIFETIME_MS = 5500;
      const STACK_GAP_PX = 32;       // vertical spacing between queued flashes
      const STACK_WINDOW_MS = 1400;  // how long a slot is "occupied" for stacking purposes
      if (!document.getElementById('action-flash-style')) {
        const s = document.createElement('style');
        s.id = 'action-flash-style';
        s.textContent = ''
          + '@keyframes pd-action-flash-rise {'
          +   '0%   { transform: translate3d(-50%, 0px, 0); opacity: 0; }'
          +   '6%   { transform: translate3d(-50%, 0px, 0); opacity: 1; }'
          +   '60%  { transform: translate3d(-50%, 0px, 0); opacity: 1; }'
          +   '100% { transform: translate3d(-50%, -80px, 0); opacity: 0; }'
          + '}'
          + '.pd-action-flash {'
          +   'position: absolute; left: 50%;'
          +   'transform: translate3d(-50%, 0, 0);'
          +   'background: rgba(28,72,46,0.88);'
          +   'border: 1px solid rgba(50,116,76,0.6);'
          +   'padding: 5px 16px; border-radius: 999px;'
          +   'color: #fff; font-size: 0.92rem; font-weight: 600;'
          +   'text-shadow: 0 1px 2px rgba(0,0,0,0.85);'
          +   'white-space: nowrap; max-width: 96%;'
          +   'overflow: hidden; text-overflow: ellipsis;'
          +   'pointer-events: none; z-index: 5;'
          +   'animation: pd-action-flash-rise ' + LIFETIME_MS + 'ms ease-out forwards;'
          + '}'
          + '.pd-action-flash-anchor {'
          +   'position: absolute; pointer-events: none;'
          + '}';
        document.head.appendChild(s);
      }
      // Anchor a wrapper to the cam tile bounds (same trick as lottie /
      // video overlays), then drop the flash node inside it.
      const targetFn = window.__textOverlayTarget;
      const tile = typeof targetFn === 'function' ? targetFn() : null;
      const ref = tile || document.getElementById('cam-owner-slot');
      const grid = stage.parentElement;
      if (!ref || !grid) return;
      const refRect = ref.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      let left = refRect.left - gridRect.left;
      let top  = refRect.top - gridRect.top;
      let width = refRect.width;
      let height = refRect.height;
      if (width <= 1 || height <= 1) {
        width = Math.min(gridRect.width || 400, 480);
        height = width;
        left = (gridRect.width - width) / 2;
        top = 8;
      }
      // Queue accounting: how many flashes are still in their start slot?
      if (!window.__actionFlashes) window.__actionFlashes = [];
      const now = Date.now();
      window.__actionFlashes = window.__actionFlashes.filter(f => document.body.contains(f.el));
      const stackIndex = window.__actionFlashes.filter(f => (now - f.startedAt) < STACK_WINDOW_MS).length;
      const baseTopPct = 7;  // top: 7% of the cam tile
      const yOffsetPx = stackIndex * STACK_GAP_PX;
      const anchor = document.createElement('div');
      anchor.className = 'pd-action-flash-anchor';
      anchor.style.left = left + 'px';
      anchor.style.top = top + 'px';
      anchor.style.width = width + 'px';
      anchor.style.height = height + 'px';
      const flash = document.createElement('div');
      flash.className = 'pd-action-flash';
      flash.style.top = 'calc(' + baseTopPct + '% + ' + yOffsetPx + 'px)';
      // Optional per-flash colors (cam-toast sub-action). Skip if missing
      // so the default dark-green pill styling in the stylesheet applies.
      if (msg.bgColor   && /^#[0-9a-fA-F]{6}$/.test(String(msg.bgColor)))   flash.style.background = msg.bgColor;
      if (msg.textColor && /^#[0-9a-fA-F]{6}$/.test(String(msg.textColor))) flash.style.color      = msg.textColor;
      flash.textContent = text;
      anchor.appendChild(flash);
      stage.appendChild(anchor);
      const entry = { el: anchor, startedAt: now };
      window.__actionFlashes.push(entry);
      flash.addEventListener('animationend', () => { try { anchor.remove(); } catch {} });
      setTimeout(() => { try { anchor.remove(); } catch {} }, LIFETIME_MS + 300);
    }
    function _renderVideoOverlay(msg) {
      // Mounts an HTMLVideoElement at the same trigger-fx-stage the lottie
      // path uses — anchored to the host cam tile's bounds captured at mount
      // time so position/size survive a cam-tile teardown (e.g. a later
      // turn-off-host-cam in the same chain). Alpha-WebM composites
      // transparently in Chrome/Firefox/Edge; Safari falls back to opaque.
      const stage0 = document.getElementById('trigger-fx-stage');
      if (msg && msg.mode === 'clear') {
        if (stage0) stage0.innerHTML = '';
        clearTimeout(window.__triggerFxTimer);
        return;
      }
      const safe = String(msg.path || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      if (!safe) return;
      const stage = stage0;
      if (!stage) return;

      const targetFn = window.__textOverlayTarget;
      const tile = typeof targetFn === 'function' ? targetFn() : null;
      const ref = tile || document.getElementById('cam-owner-slot');
      const grid = stage.parentElement;
      if (!ref || !grid) return;
      const refRect = ref.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      let left = refRect.left - gridRect.left;
      let top  = refRect.top - gridRect.top;
      let width = refRect.width;
      let height = refRect.height;
      if (width <= 1 || height <= 1) {
        width = Math.min(gridRect.width || 400, 480);
        height = width;
        left = (gridRect.width - width) / 2;
        top = 8;
      }

      const xPct = Math.max(0, Math.min(100, Number(msg.xPct != null ? msg.xPct : 50)));
      const yPct = Math.max(0, Math.min(100, Number(msg.yPct != null ? msg.yPct : 50)));
      const wPct = Math.max(5, Math.min(100, Number(msg.widthPct != null ? msg.widthPct : 40)));
      const loop = !!msg.loop;
      const freeze = !!msg.freezeLastFrame;
      const muted = !!msg.muted;

      // End-behavior data extracted up front (intro-outro uses its own
      // anchor point + slide directions which override xPct/yPct).
      const endBehavior = msg.endBehavior || (msg.clearOnComplete ? 'clear' : 'default');
      const isIntroOutro = endBehavior === 'intro-outro' && msg.cornerSlide;
      const circleCrop = !!msg.circleCrop;
      const cropStyle = circleCrop ? 'border-radius:50%;overflow:hidden;' : '';

      // For intro/outro Corner Slide, snap the slot to the chosen anchor
      // (corners or center). Y-position depends on the slot's actual height-
      // as-pct-of-cam, which is wPct * (camAspect / srcAspect) — only known
      // after the video metadata loads. We mount with a srcAspect=1 fallback
      // and correct the position on loadedmetadata before starting slide-in.
      function _anchorPos(anchor, wp, stageW, stageH, srcAspect) {
        const halfW = wp / 2;
        const slotHpct = (wp * (stageW / stageH) / Math.max(srcAspect, 0.0001));
        const halfH = Math.min(50, slotHpct / 2);
        const map = {
          'TL': [halfW, halfH], 'TR': [100 - halfW, halfH], 'C': [50, 50],
          'BL': [halfW, 100 - halfH], 'BR': [100 - halfW, 100 - halfH],
        };
        return map[anchor] || [50, 50];
      }
      let mountX = xPct, mountY = yPct;
      let initialSlideTx = '', exitSlideTx = '';
      if (isIntroOutro) {
        const cs = msg.cornerSlide;
        const [fx, fy] = _anchorPos(cs.anchor, wPct, width, height, 1);
        mountX = fx; mountY = fy;
        // Sliding offset: enough to push the slot fully past the cam edge.
        // Slot width = wPct% of stage width, so a translateX of ±(200%) of
        // its own width consistently clears the cam tile in any direction.
        const offTx = { 'left': 'translateX(-200%)', 'right': 'translateX(200%)',
                        'top':  'translateY(-200%)', 'bottom': 'translateY(200%)' };
        initialSlideTx = offTx[cs.slideIn]  || 'translateX(200%)';
        exitSlideTx    = offTx[cs.slideOut] || 'translateX(200%)';
      }

      // For intro/outro we need the slot to START at its slide-in offset, so
      // bake that into the initial transform string.
      const baseTx = 'translate(-50%, -50%)';
      const startTx = isIntroOutro ? (baseTx + ' ' + initialSlideTx) : baseTx;
      // overflow:hidden clips the slot to the cam-tile bounds so intro/outro
      // slides only become visible inside the frame — the video appears to
      // come from nowhere instead of crossing the area outside the cam.
      stage.innerHTML = '<div class="lottie-trigger-stage" style="position:absolute;'
        + 'left:' + left + 'px;top:' + top + 'px;width:' + width + 'px;height:' + height + 'px;overflow:hidden">'
        + '<div class="video-trigger-slot" style="position:absolute;left:' + mountX + '%;top:' + mountY + '%;width:' + wPct + '%;transform:' + startTx + ';pointer-events:none;' + cropStyle + '">'
        +   '<video src="/assets/triggers/video/' + safe + '" '
        +     'playsinline ' + (loop ? 'loop ' : '') + (muted ? 'muted ' : '')
        +     'style="width:100%;height:auto;display:block;background:transparent"></video>'
        + '</div></div>';

      const video = stage.querySelector('video');
      if (!video) return;
      const slot = stage.querySelector('.video-trigger-slot');
      // Autoplay-with-sound is browser-restricted. If play() rejects, retry
      // muted so the visual still happens — the operator can tick "Muted"
      // upstream to suppress this fallback warning.
      const tryPlay = () => video.play().catch(() => {
        try { video.muted = true; video.play().catch(() => {}); } catch {}
      });

      if (isIntroOutro) {
        const cs = msg.cornerSlide;
        let slidIn = false;
        const startSlideIn = () => {
          if (slidIn || !slot) return;
          slidIn = true;
          // Correct the anchor position using the real source aspect once we
          // have video metadata; falls back to the srcAspect=1 mount values
          // if metadata never arrived.
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            const srcAspect = video.videoWidth / video.videoHeight;
            const [cx, cy] = _anchorPos(cs.anchor, wPct, width, height, srcAspect);
            slot.style.left = cx + '%';
            slot.style.top  = cy + '%';
          }
          void slot.offsetWidth;
          slot.style.transition = 'transform ' + cs.inMs + 'ms ease-out';
          slot.style.transform = baseTx;
        };
        if (video.readyState >= 1) startSlideIn();
        else video.addEventListener('loadedmetadata', startSlideIn, { once: true });
        // Hard fallback in case metadata never resolves (rare).
        setTimeout(startSlideIn, 1500);
        // On ended: slide out over outMs, then clear.
        video.addEventListener('ended', () => {
          if (!slot) { try { stage.innerHTML = ''; } catch {} return; }
          slot.style.transition = 'transform ' + cs.outMs + 'ms ease-in';
          slot.style.transform = baseTx + ' ' + exitSlideTx;
          setTimeout(() => { try { stage.innerHTML = ''; } catch {} }, cs.outMs + 100);
        });
      } else if (endBehavior === 'clear') {
        const clearMode = msg.clearMode === 'fade' ? 'fade' : 'vanish';
        const fadeMs = Math.max(0, Number(msg.fadeMs) || 0);
        video.addEventListener('ended', () => {
          if (clearMode === 'vanish') { try { stage.innerHTML = ''; } catch {} return; }
          try { video.pause(); video.currentTime = Math.max(0, (video.duration || 0) - 0.01); } catch {}
          if (slot) {
            slot.style.transition = 'opacity ' + fadeMs + 'ms ease-out';
            void slot.offsetWidth;
            slot.style.opacity = '0';
          }
          setTimeout(() => { try { stage.innerHTML = ''; } catch {} }, fadeMs + 100);
        });
      } else if (freeze) {
        // Default + Freeze last frame ticked: pause on the last frame.
        video.addEventListener('ended', () => { try { video.pause(); video.currentTime = Math.max(0, (video.duration || 0) - 0.01); } catch {} });
      }
      tryPlay();

      clearTimeout(window.__triggerFxTimer);
      const dur = Math.max(200, Number(msg.durationMs) || 5000);
      // Belt-and-braces fallback wipe: only when no explicit end-behavior is
      // managing the cleanup (i.e. plain default, no loop, no freeze).
      if (!loop && !freeze && endBehavior === 'default') {
        window.__triggerFxTimer = setTimeout(() => { stage.innerHTML = ''; }, dur);
      }
    }
    function _renderSessionEnding(msg) {
      // Dedicated #countdown-stage so the countdown card layers ABOVE the
      // lottie (which lives in #overlay-stage) instead of replacing it.
      const stage = document.getElementById('countdown-stage');
      if (!stage) return;
      const totalMs = Math.max(1000, Number(msg.durationMs) || 5000);
      const totalSec = Math.ceil(totalMs / 1000);
      stage.innerHTML = '<div class="session-ending-card">'
        +   '<div class="session-ending-eyebrow">Session ending in</div>'
        +   '<div class="session-ending-count" id="session-ending-count">' + totalSec + '</div>'
        +   '<div class="session-ending-sub">all controls disabled</div>'
        + '</div>';
      stage.classList.add('active');
      clearTimeout(window.__countdownTimer);
      window.__countdownTimer = setTimeout(() => {
        stage.classList.remove('active');
        stage.innerHTML = '';
      }, totalMs + 600);
      const endsAt = Date.now() + totalMs;
      clearInterval(window.__sessionEndingTick);
      window.__sessionEndingTick = setInterval(() => {
        const el = document.getElementById('session-ending-count');
        if (!el) { clearInterval(window.__sessionEndingTick); return; }
        const remainSec = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
        el.textContent = remainSec;
        if (remainSec <= 0) clearInterval(window.__sessionEndingTick);
      }, 200);
    }
    // Persistent text overlays — driven by state.textOverlays (not transient
    // bus events) so visitors who join mid-session pick up the current set.
    // Self-healing: finds the page's "host cam tile" target via the global
    // __textOverlayTarget() and inserts a .text-overlay-stage child if missing.
    // The target tile already has position:relative (set by .cam-tile CSS).
    function renderTextOverlays(state) {
      const targetFn = window.__textOverlayTarget;
      const target = typeof targetFn === 'function' ? targetFn() : null;
      const overlays = (state && state.textOverlays) || {};
      if (!target) return;
      let stage = target.querySelector('.text-overlay-stage');
      if (!stage) {
        stage = document.createElement('div');
        stage.className = 'text-overlay-stage';
        target.appendChild(stage);
      }
      stage.innerHTML = '';
      for (const anchor of ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']) {
        const ovl = overlays[anchor];
        if (!ovl) continue;
        const div = document.createElement('div');
        div.className = 'tov tov-' + anchor;
        div.style.color = ovl.fontColor || '#fff';
        div.style.fontSize = Math.max(8, Math.min(200, Number(ovl.fontSize) || 24)) + 'px';
        if (ovl.bgColor) div.style.background = ovl.bgColor;
        else div.style.background = 'transparent';
        div.textContent = ovl.text || '';
        stage.appendChild(div);
      }
    }
    function _playSound(msg) {
      try {
        const a = new Audio('/assets/triggers/sound/' + encodeURIComponent(msg.path || ''));
        if (msg.volume != null) a.volume = Math.max(0, Math.min(1, Number(msg.volume)));
        a.play().catch(e => console.warn('audio autoplay blocked:', e.message));
      } catch (e) { console.warn('play-sound failed:', e.message); }
    }
    function _renderDiceRoll(msg) {
      const dice = Array.isArray(msg.dice) ? msg.dice : [];
      if (!dice.length) return;
      const layout = _diceLayoutClass(dice.length);
      const tiles = dice.map((face, i) =>
        '<div class="dice-die" data-face="' + face + '" id="dice-die-' + i + '"></div>'
      ).join('');
      const banner = msg.by
        ? '<div class="dice-banner">🎲 ' + (msg.by || 'someone') + ' rolled ' + dice.length + 'd6 → ' + (msg.total || dice.reduce((a,b)=>a+b,0)) + '</div>'
        : '';
      _mountOverlay(
        '<div class="dice-cluster ' + layout + '">' + tiles + '</div>' + banner,
        msg.durationMs || 2500
      );
      // Load + play a Lottie for each die. If lottie isn't ready yet, fall back
      // to a giant pip number so the result is at least visible.
      const useLottie = typeof window.lottie !== 'undefined';
      dice.forEach((face, i) => {
        const el = document.getElementById('dice-die-' + i);
        if (!el) return;
        if (useLottie) {
          try {
            window.lottie.loadAnimation({
              container: el,
              path: '/assets/dice/dice-number-' + face + '.json',
              renderer: 'svg',
              loop: false,
              autoplay: true,
            });
          } catch (e) {
            el.textContent = face;
            el.classList.add('dice-fallback');
          }
        } else {
          el.textContent = face;
          el.classList.add('dice-fallback');
        }
      });
    }
  `;
}

function overlayCss() {
  return `
    #overlay-stage { position: absolute; inset: 0; pointer-events: none; z-index: 100; display: none; align-items: center; justify-content: center; }
    #overlay-stage.active { display: flex; }
    /* Countdown stage layers above #overlay-stage so the session-ending card
       coexists with whatever's currently mounted there (e.g. a frozen lottie). */
    #countdown-stage { position: absolute; inset: 0; pointer-events: none; z-index: 200; display: none; align-items: center; justify-content: center; }
    #countdown-stage.active { display: flex; }
    .dice-cluster { display: grid; gap: 18px; padding: 16px; }
    .dice-cluster.dice-1 { grid-template-columns: 1fr; }
    .dice-cluster.dice-2 { grid-template-columns: repeat(2, 1fr); }
    .dice-cluster.dice-3 { grid-template-columns: repeat(3, 1fr); }
    .dice-cluster.dice-4 { grid-template-columns: repeat(2, 1fr); }
    .dice-cluster.dice-5 { grid-template-columns: repeat(3, 1fr); }
    .dice-cluster.dice-5 .dice-die:nth-child(4) { grid-column: 1 / 2; }
    .dice-cluster.dice-5 .dice-die:nth-child(5) { grid-column: 3 / 4; }
    .dice-cluster.dice-6 { grid-template-columns: repeat(3, 1fr); }
    .dice-die { width: clamp(80px, 18vh, 180px); height: clamp(80px, 18vh, 180px); }
    .dice-die svg { width: 100% !important; height: 100% !important; }
    .dice-die.dice-fallback { display:flex; align-items:center; justify-content:center; background: var(--bg-2); border: 3px solid var(--accent); border-radius: 16px; color: var(--text); font-size: clamp(40px, 9vh, 90px); font-weight: 800; }
    .dice-banner { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); background: rgba(15,17,21,0.85); color: #fff; padding: 8px 18px; border-radius: 999px; font-size: 1rem; font-weight: 600; white-space: nowrap; max-width: 90%; overflow: hidden; text-overflow: ellipsis; }
    .wheel-stage { width: clamp(280px, 55vh, 520px); height: clamp(280px, 55vh, 520px); }
    .wheel-stage svg { width: 100%; height: 100%; overflow: visible; }
    /* transform-box: fill-box pins the rotation pivot to the element's own
       bounding box; transform-origin: center then = the wheel's geometric
       center, cross-browser. NEVER also set transform="..." on the same group. */
    .wheel-stage .wheel-rot { transform: rotate(0deg); transform-box: fill-box; transform-origin: center; will-change: transform; }
    .wheel-container { display: flex; flex-direction: column; align-items: center; gap: 18px; }
    .trigger-lottie { width: clamp(260px, 50vh, 480px); height: clamp(260px, 50vh, 480px); }
    .trigger-lottie svg { width: 100% !important; height: 100% !important; }
    /* Trigger lottie stage: lives in #trigger-fx-stage which spans the
       cam-grid. The .lottie-trigger-stage inside is explicitly sized by JS
       to match the host cam TILE's bounds at mount time, so xPct/yPct/
       widthPct percentages map 1:1 to the cam tile. The slot has no forced
       aspect — the SVG renders at its natural aspect within the width. */
    #trigger-fx-stage { position: absolute; inset: 0; pointer-events: none; z-index: 11; }
    .cam-grid { position: relative; }
    .lottie-trigger-stage { pointer-events: none; }
    .lottie-trigger-stage .lottie-trigger-slot { position: absolute; transform: translate(-50%, -50%); }
    .lottie-trigger-stage .lottie-trigger-slot svg { width: 100% !important; height: auto !important; display: block; }
    /* Session-ending countdown — full stage card. */
    .session-ending-card { background: rgba(15,17,21,0.92); border: 2px solid #f08484; border-radius: 18px; padding: 38px 56px; text-align: center; box-shadow: 0 12px 48px rgba(0,0,0,0.7); }
    .session-ending-eyebrow { color: #f08484; font-size: clamp(1rem, 2.4vh, 1.4rem); letter-spacing: 0.08em; text-transform: uppercase; font-weight: 700; margin-bottom: 14px; }
    .session-ending-count { color: #fff; font-size: clamp(6rem, 22vh, 12rem); font-weight: 900; line-height: 1; font-variant-numeric: tabular-nums; }
    .session-ending-sub { color: #f0c674; font-size: clamp(0.9rem, 2vh, 1.05rem); margin-top: 10px; font-style: italic; }
    /* Persistent text overlays painted over the host's cam tile. The stage is
       inserted as a child of the tile (.cam-tile already has position:relative). */
    .text-overlay-stage { position: absolute; inset: 0; pointer-events: none; z-index: 12; }
    .text-overlay-stage .tov { position: absolute; padding: 4px 10px; border-radius: 6px; max-width: 80%; font-weight: 700; line-height: 1.2; white-space: pre-line; word-wrap: break-word; overflow-wrap: anywhere; text-shadow: 0 1px 2px rgba(0,0,0,0.7); }
    .text-overlay-stage .tov-top-left     { top: 8px;    left: 8px; text-align: left; }
    .text-overlay-stage .tov-top-right    { top: 8px;    right: 8px; text-align: right; }
    .text-overlay-stage .tov-bottom-left  { bottom: 8px; left: 8px; text-align: left; }
    .text-overlay-stage .tov-bottom-right { bottom: 8px; right: 8px; text-align: right; }
    .text-overlay-stage .tov-center       { top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; }
  `;
}

module.exports = { overlayJs, overlayCss };
