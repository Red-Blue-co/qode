document.addEventListener('DOMContentLoaded', () => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // --- Desktop only: soft red/blue glow following the cursor ---
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches && !reduceMotion) {
        const wrap = document.createElement('div');
        wrap.className = 'cursor-wrapper';
        const red = document.createElement('div');
        red.className = 'cursor-magnet magnet-red';
        const blue = document.createElement('div');
        blue.className = 'cursor-magnet magnet-blue';
        wrap.append(red, blue);
        document.body.prepend(wrap);
        let mx = innerWidth / 2, my = innerHeight / 2, cx = mx, cy = my, rot = 0;
        document.addEventListener('mousemove', (e) => {
            mx = e.clientX; my = e.clientY;
            red.style.opacity = blue.style.opacity = '1';
        });
        document.addEventListener('mouseleave', () => { red.style.opacity = blue.style.opacity = '0'; });
        (function follow() {
            cx += (mx - cx) * 0.25; cy += (my - cy) * 0.25; rot += 1.5;
            red.style.transform = `translate(${cx - 100}px, ${cy - 300}px) rotate(${rot}deg)`;
            blue.style.transform = `translate(${cx - 100}px, ${cy - 300}px) rotate(${rot + 90}deg)`;
            requestAnimationFrame(follow);
        })();
    }

    // --- Segmented controls: slide the thumb under the active button ---
    function placeThumb(group) {
        const thumb = group.querySelector('.thumb');
        const active = group.querySelector('button.active');
        if (!thumb || !active) return;
        thumb.style.width = `${active.offsetWidth}px`;
        thumb.style.transform = `translateX(${active.offsetLeft - 4}px)`;
    }
    const segmented = [...document.querySelectorAll('.segmented')];
    const placeAll = () => segmented.forEach(placeThumb);
    placeAll();
    window.addEventListener('resize', placeAll);
    if (document.fonts) document.fonts.ready.then(placeAll);

    // --- Generator ---
    const qodeText = document.getElementById('qode-text');
    const qodeEcc = document.getElementById('qode-ecc');
    const qodeImage = document.getElementById('qode-image');
    const stage = document.getElementById('stage');
    const saveBtn = document.getElementById('save-btn');
    const charCount = document.getElementById('char-count');
    const strength = document.getElementById('strength');
    let currentObjectUrl = null;
    let genSeq = 0;

    const STRENGTH = {
        1: ['Light', 'Fits the most text. Best for clean screens and prints.'],
        2: ['Balanced', 'Each digit is stored three times, so scuffs and glare are no problem.'],
        3: ['Strong', 'Each digit is stored five times. For rough surfaces and long distances.'],
    };

    if (qodeText && qodeImage) {
        const updateCount = () => { if (charCount) charCount.textContent = `${qodeText.value.length} / ${qodeText.maxLength}`; };
        let timer = null;
        qodeText.addEventListener('input', () => {
            updateCount();
            clearTimeout(timer);
            timer = setTimeout(generateQode, 350);
        });
        if (strength) {
            strength.addEventListener('click', (e) => {
                const b = e.target.closest('button[data-ecc]');
                if (!b) return;
                strength.querySelectorAll('button').forEach((x) => {
                    x.classList.toggle('active', x === b);
                    x.setAttribute('aria-checked', String(x === b));
                });
                placeThumb(strength);
                qodeEcc.value = b.dataset.ecc;
                const [name, text] = STRENGTH[b.dataset.ecc];
                document.getElementById('strength-hint').textContent = name;
                document.getElementById('strength-text').textContent = text;
                generateQode();
            });
        }
        updateCount();
        generateQode();
    }

    async function generateQode() {
        const text = qodeText.value.trim() || 'QODE';
        const seq = ++genSeq;
        stage.classList.add('busy');
        qodeImage.classList.add('hidden');
        try {
            const response = await fetch(`api/generate?text=${encodeURIComponent(text)}&ecc=${qodeEcc.value || 2}`);
            if (!response.ok) throw new Error('Generation failed');
            const blob = await response.blob();
            if (seq !== genSeq) return; // a newer request is on its way
            if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
            currentObjectUrl = URL.createObjectURL(blob);
            qodeImage.onload = () => {
                stage.classList.remove('busy');
                qodeImage.classList.remove('hidden');
            };
            qodeImage.src = currentObjectUrl;
        } catch (err) {
            if (seq === genSeq) stage.classList.remove('busy');
            console.error(err);
        }
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            if (!currentObjectUrl) return;
            const link = document.createElement('a');
            link.href = currentObjectUrl;
            link.download = `qode-${Date.now()}.png`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            const label = saveBtn.querySelector('span');
            saveBtn.classList.add('done');
            label.textContent = 'Saved';
            setTimeout(() => { saveBtn.classList.remove('done'); label.textContent = 'Save image'; }, 1800);
        });
    }

    // --- Scanner: live decoding in the browser ---
    // Camera frames are decoded continuously in Web Workers (no upload, no server).
    // An outline follows the Qode while it is tracked; the text locks in once two
    // frames agree, or at once when a single read is very clear.
    const cameraView = document.getElementById('camera-view');
    const uploadView = document.getElementById('upload-view');
    const lens = document.getElementById('lens');
    const modeCameraBtn = document.getElementById('mode-camera');
    const modeUploadBtn = document.getElementById('mode-upload');
    const videoFeed = document.getElementById('video-feed');
    const snapPreview = document.getElementById('scan-snap-preview');
    const captureCanvas = document.getElementById('capture-canvas');
    const trackCanvas = document.getElementById('track-overlay');
    const scanBtn = document.getElementById('scan-btn');
    const resultBox = document.getElementById('result-box');
    const scanResult = document.getElementById('scan-result');
    const resultKind = document.getElementById('result-kind');
    const openBtn = document.getElementById('open-btn');
    const copyBtn = document.getElementById('copy-btn');
    const fileInput = document.getElementById('file-input');
    const dropzone = document.getElementById('dropzone');
    const uploadPreview = document.getElementById('uploaded-preview');
    const changePhoto = document.getElementById('change-photo');
    const statusBox = document.getElementById('status');
    const scanStatus = document.getElementById('scan-status');

    const isScannerPage = !!(cameraView && videoFeed);
    if (!isScannerPage) return;

    const TRACK_SIZE = 640;      // longest side of the small frames used for tracking
    const READ_SIZE = 1920;      // longest side of the full frames used for reading
    const MIN_READ_DIAMETER = 120; // px across (in a full frame) before reading is worth it
    const LOST_AFTER = 1200;     // ms without seeing the code before starting over

    let activeStream = null;
    let liveRunning = false;
    let isLocked = false;
    let tracking = null;         // latest outline and state from the tracker
    let shown = null;            // outline as drawn (eased toward the latest, in view px)
    let seenAt = 0;              // last time the tracker saw the code
    let reads = [];              // texts read from frames of the code being tracked
    let lastText = '';           // the decoded text currently shown
    let lastStatus = '';

    // state: idle | searching | reading | done | error (colours the status dot)
    const setStatus = (text, state = 'searching') => {
        if (statusBox) statusBox.dataset.state = state;
        if (scanStatus && text !== lastStatus) {
            scanStatus.textContent = text;
            lastStatus = text;
            scanStatus.classList.remove('swap');
            void scanStatus.offsetWidth;
            scanStatus.classList.add('swap');
        }
    };

    // Two workers so neither waits on the other: one tracks (fast, every frame),
    // one reads (thorough, full resolution, takes as long as it needs).
    function makeEngine() {
        let w = null, pending = null, id = 0;
        if (window.Worker) {
            try {
                w = new Worker('qode-worker.js?v=7');
                w.onmessage = (e) => { const cb = pending; pending = null; if (cb) cb(e.data.result); };
                w.onerror = () => { w = null; const cb = pending; pending = null; if (cb) cb(null); };
            } catch (e) { w = null; }
        }
        const plain = (l) => ({ found: l.found, foundCount: l.foundCount, outline: l.outline, center: l.center, diameter: l.diameter });
        return {
            get busy() { return !!pending; },
            run(type, imageData, options) {
                return new Promise((resolve) => {
                    pending = resolve;
                    if (w) {
                        w.postMessage({ id: ++id, type, width: imageData.width, height: imageData.height, buffer: imageData.data.buffer, options }, [imageData.data.buffer]);
                        return;
                    }
                    // Very old browsers: decode on the page instead
                    const ready = window.QodeDecoder ? Promise.resolve() : loadScript('qode-decoder.js?v=7');
                    ready.then(() => {
                        const D = window.QodeDecoder;
                        const r = type === 'locate' ? plain(D.locate(imageData)) : D.decode(imageData, options);
                        const cb = pending; pending = null; cb(r);
                    });
                });
            },
        };
    }
    function loadScript(src) {
        return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    }
    const tracker = makeEngine();
    const reader = makeEngine();

    // --- Camera / upload switch ---
    modeCameraBtn.addEventListener('click', () => switchMode('camera'));
    modeUploadBtn.addEventListener('click', () => switchMode('upload'));
    startCamera();

    function switchMode(mode) {
        const camera = mode === 'camera';
        modeCameraBtn.classList.toggle('active', camera);
        modeUploadBtn.classList.toggle('active', !camera);
        placeThumb(modeCameraBtn.parentElement);
        cameraView.classList.toggle('active', camera);
        uploadView.classList.toggle('active', !camera);
        clearLock();
        if (camera) {
            startCamera();
        } else {
            stopCamera();
            resetUpload();
        }
    }

    async function startCamera() {
        if (activeStream) { startLive(); return; }
        setStatus('Starting camera…', 'idle');
        try {
            activeStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
                audio: false,
            });
            videoFeed.srcObject = activeStream;
            await videoFeed.play().catch(() => {});
            cameraView.classList.add('live');
            setStatus('Point the camera at a Qode.');
            startLive();
        } catch (err) {
            console.error('Camera error:', err);
            setStatus(location.protocol === 'https:' || location.hostname === 'localhost'
                ? 'No camera access. You can upload a photo instead.'
                : 'The camera needs HTTPS. You can upload a photo instead.', 'error');
        }
    }

    function stopCamera() {
        liveRunning = false;
        if (activeStream) {
            activeStream.getTracks().forEach((t) => t.stop());
            videoFeed.srcObject = null;
            activeStream = null;
        }
        cameraView.classList.remove('live', 'tracking');
        forgetCode();
        drawOverlay();
    }

    function startLive() {
        if (liveRunning) return;
        liveRunning = true;
        requestAnimationFrame(liveLoop);
    }

    // Current video frame, scaled so its longest side is at most maxSide
    const trackBuffer = document.createElement('canvas');
    function grab(canvas, maxSide) {
        const vw = videoFeed.videoWidth, vh = videoFeed.videoHeight;
        if (!vw || !vh) return null;
        const k = Math.min(1, maxSide / Math.max(vw, vh));
        const w = Math.round(vw * k), h = Math.round(vh * k);
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(videoFeed, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h);
    }

    function forgetCode() {
        tracking = null;
        morphStart = 0;
        reads = [];
        cameraView.classList.remove('tracking');
    }

    function liveLoop() {
        if (!liveRunning) return;
        requestAnimationFrame(liveLoop);
        drawOverlay();
        if (isLocked || videoFeed.readyState < videoFeed.HAVE_CURRENT_DATA) return;
        if (!tracker.busy) track();
        // Keep reading full frames while the code is in view. Before the tracker has
        // found anything, read anyway: the first frame may already be readable.
        const inView = tracking ? tracking.readable && performance.now() - seenAt < 400 : true;
        if (!reader.busy && inView) read();
    }

    // Fast pass: where is the code? Runs on small frames, many times a second.
    function track() {
        const frame = grab(trackBuffer, TRACK_SIZE);
        if (!frame) return;
        const fw = frame.width, fh = frame.height;
        tracker.run('locate', frame).then((loc) => {
            if (isLocked || !loc) return;
            const now = performance.now();
            if (!loc.found) {
                if (now - seenAt > LOST_AFTER) {
                    if (tracking) forgetCode();
                    setStatus('Point the camera at a Qode.');
                }
                return;
            }
            seenAt = now;
            const fullDiameter = loc.diameter * (videoFeed.videoWidth / fw);
            const readable = loc.foundCount >= 3 && fullDiameter >= MIN_READ_DIAMETER;
            tracking = { outline: loc.outline, fw, fh, readable, state: readable ? 'reading' : 'tracking' };
            cameraView.classList.add('tracking');
            if (loc.foundCount < 3) setStatus('Fit the whole Qode in view.');
            else if (!readable) setStatus('Move a little closer.');
            else setStatus('Reading…', 'reading');
        });
    }

    // Thorough pass: read the text from a full-resolution frame. Each frame is read
    // on its own; the text locks once two frames agree (three for codes without copies),
    // or at once when a single read is very clear.
    function read() {
        const frame = grab(captureCanvas, READ_SIZE);
        if (!frame) return;
        const fw = frame.width, fh = frame.height;
        reader.run('decode', frame, { strictness: 0.75 }).then((r) => {
            if (isLocked || !r || !r.success) return;
            reads.push(r.payload);
            const agree = reads.filter((t) => t === r.payload).length;
            // A very clear read of a code with copies needs no second frame
            const sure = r.meta.firstChoice && r.meta.ecc >= 2 && r.meta.confidence >= 0.9;
            if (sure || agree >= (r.meta.ecc === 1 ? 3 : 2)) {
                tracking = { outline: r.meta.outline, fw, fh, readable: true, state: 'read' };
                shown = null;
                lockScan(r.payload);
            }
        });
    }

    // --- Outline over the video (matches object-fit: cover) ---
    function overlayContext() {
        if (!trackCanvas) return null;
        const dpr = window.devicePixelRatio || 1;
        const cw = trackCanvas.clientWidth, ch = trackCanvas.clientHeight;
        if (trackCanvas.width !== Math.round(cw * dpr) || trackCanvas.height !== Math.round(ch * dpr)) {
            trackCanvas.width = Math.round(cw * dpr);
            trackCanvas.height = Math.round(ch * dpr);
        }
        const ctx = trackCanvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        return { ctx, cw, ch };
    }

    function frameToView(p, fw, fh, cw, ch) {
        const vw = videoFeed.videoWidth || fw, vh = videoFeed.videoHeight || fh;
        const s = Math.max(cw / vw, ch / vh);
        const ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
        return { x: p.x * (vw / fw) * s + ox, y: p.y * (vh / fh) * s + oy };
    }

    // The four anchors, as drawn by the generator (degrees around the code)
    const ANCHOR_ARCS = [
        { from: 200, to: 250, color: '255, 62, 62' },   // red, solid
        { from: 290, to: 340, color: '77, 130, 255' },  // blue, dotted
        { from: 20, to: 70, color: '34, 197, 94' },     // green, dashed
        { from: 110, to: 160, color: '250, 204, 21' },  // yellow, double
    ];
    const RETICLE_R = 0.34; // the lens arcs' radius, as a share of the lens width
    let morphStart = 0;

    // A point on the code's anchor ring at this angle (the outline has a point every 15°)
    function onOutline(pts, deg) {
        const f = (((deg % 360) + 360) % 360) / 15;
        const i = Math.floor(f), k = f - i;
        const p = pts[i % 24], q = pts[(i + 1) % 24];
        return { x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k };
    }

    const easeOut = (x) => 1 - Math.pow(1 - x, 3);

    // The four lens arcs fly onto the code's own anchors and follow them
    function drawOverlay() {
        const o = overlayContext();
        if (!o) return;
        if (!tracking || !tracking.outline) { shown = null; morphStart = 0; return; }
        const now = performance.now();
        if (!morphStart) morphStart = now;
        const lost = !isLocked && now - seenAt > 350;
        const target = tracking.outline.map((p) => frameToView(p, tracking.fw, tracking.fh, o.cw, o.ch));
        // Ease toward the latest position so the arcs glide instead of jumping
        shown = shown && shown.length === target.length
            ? shown.map((p, i) => ({ x: p.x + (target[i].x - p.x) * 0.45, y: p.y + (target[i].y - p.y) * 0.45 }))
            : target;
        const m = easeOut(Math.min(1, (now - morphStart) / 520));
        const cx = o.cw / 2, cy = o.ch / 2, r = o.cw * RETICLE_R;
        const { ctx } = o;
        const state = tracking.state;
        const pulse = state === 'reading' && !lost ? 0.7 + 0.3 * Math.sin(now / 160) : 1;
        const alpha = (lost ? 0.35 : 1) * pulse;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Once read, a gradient ring closes around the code
        if (state === 'read') {
            const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
            g.addColorStop(0, 'rgba(255, 62, 62, 0.9)');
            g.addColorStop(1, 'rgba(77, 124, 255, 0.9)');
            ctx.strokeStyle = g;
            ctx.lineWidth = 2;
            ctx.shadowColor = 'rgba(255, 62, 62, 0.6)';
            ctx.shadowBlur = 14;
            ctx.beginPath();
            shown.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            ctx.closePath();
            ctx.stroke();
        }

        for (const arc of ANCHOR_ARCS) {
            ctx.beginPath();
            for (let k = 0; k <= 12; k++) {
                const deg = arc.from + ((arc.to - arc.from) * k) / 12;
                const rad = (deg * Math.PI) / 180;
                const start = { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
                const end = onOutline(shown, deg);
                const x = start.x + (end.x - start.x) * m, y = start.y + (end.y - start.y) * m;
                if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
            }
            // White while flying in, then each takes its anchor's colour
            const c = m < 1 ? '255, 255, 255' : arc.color;
            ctx.strokeStyle = `rgba(${c}, ${alpha})`;
            ctx.shadowColor = `rgba(${arc.color}, ${0.9 * alpha})`;
            ctx.shadowBlur = state === 'read' ? 18 : 12;
            ctx.lineWidth = state === 'read' ? 5 : 4;
            ctx.stroke();
        }
        ctx.shadowBlur = 0;
    }

    // --- Lock (result found) ---
    function lockScan(payload) {
        if (isLocked) return;
        isLocked = true;
        // Freeze the frame the text was read from
        snapPreview.src = captureCanvas.toDataURL('image/jpeg', 0.85);
        snapPreview.classList.remove('hidden');
        celebrate(cameraView);
        try { videoFeed.pause(); } catch (e) {}
        showResult(payload);
    }

    function celebrate(container) {
        container.classList.remove('locked');
        void container.offsetWidth; // restart the animations
        container.classList.add('locked');
        lens.classList.remove('locked');
        void lens.offsetWidth;
        lens.classList.add('locked');
        setStatus('Qode read', 'done');
        // Browsers only allow vibration after the person has tapped the page
        if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate([30, 40, 60]);
    }

    function clearLock() {
        isLocked = false;
        forgetCode();
        snapPreview.classList.add('hidden');
        snapPreview.src = '';
        resultBox.classList.add('hidden');
        lastText = '';
        lens.classList.remove('locked');
        document.querySelectorAll('.scanner-container').forEach((c) => c.classList.remove('locked'));
        drawOverlay();
    }

    function resetLock() {
        clearLock();
        setStatus('Point the camera at a Qode.');
        try { videoFeed.play(); } catch (e) {}
        startLive();
    }

    // What kind of text is it? Links get an "Open" button.
    function kindOf(text) {
        const t = text.trim();
        if (/^https?:\/\/\S+$/i.test(t)) return { label: 'Link', href: t };
        if (/^www\.\S+\.\S+$/i.test(t)) return { label: 'Link', href: `https://${t}` };
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return { label: 'Email', href: `mailto:${t}` };
        if (/^\+?[\d\s()-]{7,}$/.test(t)) return { label: 'Phone', href: `tel:${t.replace(/[^\d+]/g, '')}` };
        return { label: 'Text', href: null };
    }

    function showResult(text) {
        lastText = text;
        const kind = kindOf(text);
        resultKind.textContent = kind.label;
        if (kind.href) {
            openBtn.href = kind.href;
            openBtn.lastChild.textContent = kind.label === 'Link' ? ' Open link' : kind.label === 'Email' ? ' Write email' : ' Call';
            openBtn.classList.remove('hidden');
        } else {
            openBtn.classList.add('hidden');
        }
        resultBox.classList.remove('hidden');
        // Restart the slide-in each time
        resultBox.style.animation = 'none';
        void resultBox.offsetWidth;
        resultBox.style.animation = '';
        decrypt(scanResult, text);
    }

    // Text "decrypts" from random glyphs into the real characters, left to right
    let decryptTimer = null;
    function decrypt(el, text) {
        cancelAnimationFrame(decryptTimer);
        if (reduceMotion || text.length > 160) { el.textContent = text; return; }
        const glyphs = '◇◆○●◎⬡⬢01<>/#*+=';
        const chars = [...text];
        const start = performance.now();
        const perChar = Math.max(12, Math.min(35, 700 / chars.length));
        function frame(now) {
            const done = Math.max(0, Math.floor((now - start - 120) / perChar));
            // The next few characters flicker as random glyphs before settling
            let noise = '';
            for (let i = done; i < Math.min(chars.length, done + 10); i++) {
                noise += chars[i] === ' ' ? ' ' : glyphs[Math.floor(Math.random() * glyphs.length)];
            }
            el.textContent = chars.slice(0, done).join('');
            if (done < chars.length) {
                const n = document.createElement('span');
                n.className = 'scramble';
                n.textContent = noise;
                el.append(n);
                decryptTimer = requestAnimationFrame(frame);
            }
        }
        decryptTimer = requestAnimationFrame(frame);
    }

    // --- Upload: decoded in the browser too ---
    function resetUpload() {
        fileInput.value = '';
        uploadPreview.classList.add('hidden');
        uploadPreview.removeAttribute('src');
        dropzone.classList.remove('hidden');
        changePhoto.classList.add('hidden');
        setStatus('Choose a photo or screenshot of a Qode.', 'idle');
    }

    async function readUpload(file) {
        setStatus('Reading photo…', 'reading');
        try {
            const url = URL.createObjectURL(file);
            const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
            uploadPreview.src = url;
            uploadPreview.classList.remove('hidden');
            dropzone.classList.add('hidden');
            changePhoto.classList.remove('hidden');
            const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
            const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
            captureCanvas.width = w;
            captureCanvas.height = h;
            const ctx = captureCanvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, w, h);
            // A single image gets no second read, so it must be clear on its own
            const result = (await reader.run('decode', ctx.getImageData(0, 0, w, h), { strictness: 1, minDiameter: 100 })) || {};
            if (result.success) {
                celebrate(uploadView);
                showResult(result.payload);
            } else {
                const why = {
                    'No Qode anchors found': 'No Qode found in this photo.',
                    'Move closer': 'The Qode is too small. Crop closer or use a larger photo.',
                    'Need all anchors in view': 'Part of the Qode is cut off.',
                    'Could not read the dots yet': 'Too blurry or dark to read reliably.',
                }[result.reason];
                setStatus(why || 'Could not read this photo.', 'error');
            }
        } catch (e) {
            setStatus('Could not open this image.', 'error');
        }
    }

    scanBtn.addEventListener('click', () => {
        if (cameraView.classList.contains('active')) {
            if (isLocked) resetLock();
            else startCamera();
        } else {
            clearLock();
            resetUpload();
            fileInput.click();
        }
    });

    copyBtn.addEventListener('click', async () => {
        if (!lastText) return;
        try { await navigator.clipboard.writeText(lastText); }
        catch (e) {
            const t = document.createElement('textarea');
            t.value = lastText; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
        }
        const label = copyBtn.querySelector('span');
        copyBtn.classList.add('done');
        label.textContent = 'Copied';
        setTimeout(() => { copyBtn.classList.remove('done'); label.textContent = 'Copy'; }, 1500);
    });

    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file) { clearLock(); readUpload(file); }
    });
    fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (file) { clearLock(); readUpload(file); }
    });
    changePhoto.addEventListener('click', () => { clearLock(); resetUpload(); fileInput.click(); });

    // Stop the camera when the tab is hidden, resume when it comes back
    document.addEventListener('visibilitychange', () => {
        if (!cameraView.classList.contains('active')) return;
        if (document.hidden) stopCamera();
        else if (!isLocked) startCamera();
    });
});
