console.log("%c Qode ", "background: linear-gradient(to right, #ff3333, #3366ff); color: white; padding: 5px 10px; border-radius: 5px; font-weight: bold;", "Welcome to the future of connectivity.");

document.addEventListener('DOMContentLoaded', () => {

    // --- Magnetic Siren Cursor ---
    const cursorWrapper = document.createElement('div');
    cursorWrapper.classList.add('cursor-wrapper');
    document.body.appendChild(cursorWrapper);

    const redLobe = document.createElement('div');
    redLobe.classList.add('cursor-magnet', 'magnet-red');
    cursorWrapper.appendChild(redLobe);

    const blueLobe = document.createElement('div');
    blueLobe.classList.add('cursor-magnet', 'magnet-blue');
    cursorWrapper.appendChild(blueLobe);

    let mouseX = window.innerWidth / 2;
    let mouseY = window.innerHeight / 2;
    let cursorX = mouseX;
    let cursorY = mouseY;
    let rotation = 0;

    let isHoveringInteractive = false;

    // Fade out cursor on interactive elements (Inputs, Nav, Scanner Lens)
    const interactiveElements = document.querySelectorAll('input, button, a, textarea, .glass-nav, .scanner-container, .qode-preview-container, .dropzone, label');
    interactiveElements.forEach(el => {
        el.addEventListener('mouseenter', () => isHoveringInteractive = true);
        el.addEventListener('mouseleave', () => isHoveringInteractive = false);
    });

    document.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });

    function animateCursor() {
        // Only show if NOT hovering interactive elements
        if (!isHoveringInteractive) {
            redLobe.style.opacity = '1';
            blueLobe.style.opacity = '1';
        } else {
            redLobe.style.opacity = '0';
            blueLobe.style.opacity = '0';
        }
        // Smooth follow (Speed increased to 0.4 to reduce delay)
        const dx = mouseX - cursorX;
        const dy = mouseY - cursorY;
        cursorX += dx * 0.4;
        cursorY += dy * 0.4;

        // Continuous Rotation
        rotation += 2; // Speed of siren

        // Position Red Lobe (Offset by rotation)
        redLobe.style.transform = `translate(${cursorX - 100}px, ${cursorY - 300}px) rotate(${rotation}deg)`;

        // Position Blue Lobe (Offset + 180deg)
        blueLobe.style.transform = `translate(${cursorX - 100}px, ${cursorY - 300}px) rotate(${rotation + 90}deg)`;

        requestAnimationFrame(animateCursor);
    }
    animateCursor();


    // --- Keyboard Visuals (Pulse Effect) ---
    const heroText = document.querySelector('.gradient-headline') || document.querySelector('.gradient-text');
    const heroCard = document.querySelector('.card-stack');

    document.addEventListener('keydown', (e) => {
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        triggerPulse();
    });

    function triggerPulse() {
        if (heroText) {
            heroText.classList.remove('pulse-active');
            void heroText.offsetWidth;
            heroText.classList.add('pulse-active');
        }
        if (heroCard) {
            heroCard.classList.remove('bounce-active');
            void heroCard.offsetWidth;
            heroCard.classList.add('bounce-active');
        }
    }

    // --- Home Page Logic ---
    const ctaBtn = document.querySelector('.hero .btn-primary.large');
    if (ctaBtn) {
        ctaBtn.addEventListener('click', () => {
            window.location.href = 'generator.html';
        });
    }

    // --- Generator Logic ---
    const generateBtn = document.getElementById('generate-btn');
    const saveBtn = document.getElementById('save-btn');
    const qodeText = document.getElementById('qode-text');
    const qodeEcc = document.getElementById('qode-ecc');
    const qodeImage = document.getElementById('qode-image');
    let currentObjectUrl = null;

    if (qodeText && qodeImage) generateQode();
    if (generateBtn) generateBtn.addEventListener('click', generateQode);

    async function generateQode() {
        const text = qodeText.value || "hello word this qode";
        const ecc = qodeEcc.value || 2;
        qodeImage.classList.add('hidden');

        try {
            const response = await fetch(`/api/generate?text=${encodeURIComponent(text)}&ecc=${ecc}`);
            if (!response.ok) throw new Error('Generation failed');

            const blob = await response.blob();
            if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
            currentObjectUrl = URL.createObjectURL(blob);

            qodeImage.onload = () => {
                qodeImage.classList.remove('hidden');
            };
            qodeImage.src = currentObjectUrl;
            resetSaveButton();

        } catch (err) {
            console.error(err);
            alert("Failed to generate Qode.");
        }
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            if (!currentObjectUrl) return;
            saveBtn.classList.add('loading');
            await new Promise(r => setTimeout(r, 1500));

            const link = document.createElement('a');
            link.href = currentObjectUrl;
            link.download = `qode-${Date.now()}.png`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            saveBtn.classList.remove('loading');
            saveBtn.classList.add('success');
            setTimeout(() => { resetSaveButton(); }, 3000);
        });
    }

    function resetSaveButton() {
        if (!saveBtn) return;
        saveBtn.classList.remove('loading', 'success');
    }

    // --- Scanner: live decoding in the browser ---
    // Camera frames are decoded continuously in a Web Worker (no upload, no server).
    // A frame is shown around the Qode while it is tracked; the text locks in once
    // two frames in a row read the same thing.
    const cameraView = document.getElementById('camera-view');
    const uploadView = document.getElementById('upload-view');
    const modeCameraBtn = document.getElementById('mode-camera');
    const modeUploadBtn = document.getElementById('mode-upload');
    const videoFeed = document.getElementById('video-feed');
    const snapPreview = document.getElementById('scan-snap-preview');
    const captureCanvas = document.getElementById('capture-canvas');
    const trackCanvas = document.getElementById('track-overlay');
    const scanBtn = document.getElementById('scan-btn');
    const resultBox = document.getElementById('result-box');
    const scanResult = document.getElementById('scan-result');
    const fileInput = document.getElementById('file-input');
    const dropzone = document.getElementById('dropzone');
    const uploadPreview = document.getElementById('uploaded-preview');
    const scanStatus = document.getElementById('scan-status');
    const copyBtn = document.getElementById('copy-btn');
    const lockRing = document.getElementById('lock-ring');
    const decodedOverlay = document.getElementById('decoded-overlay');
    const decodedText = document.getElementById('decoded-text');

    const isScannerPage = !!(cameraView && videoFeed);
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
    let readFrames = 0;          // full frames read for the code being tracked
    let lastStatus = '';

    const setStatus = (t) => {
        if (scanStatus && t !== lastStatus) { scanStatus.innerText = t; lastStatus = t; }
    };

    // Two workers so neither waits on the other: one tracks (fast, every frame),
    // one reads (thorough, full resolution, takes as long as it needs).
    function makeEngine() {
        let w = null, pending = null, id = 0;
        if (isScannerPage && window.Worker) {
            try {
                w = new Worker('qode-worker.js?v=5');
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
                    const ready = window.QodeDecoder ? Promise.resolve() : loadScript('qode-decoder.js?v=5');
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

    // Mode switching
    if (modeCameraBtn && modeUploadBtn) {
        modeCameraBtn.addEventListener('click', () => switchMode('camera'));
        modeUploadBtn.addEventListener('click', () => switchMode('upload'));
        if (isScannerPage) startCamera();
    }

    function switchMode(mode) {
        const camera = mode === 'camera';
        modeCameraBtn.classList.toggle('active', camera);
        modeUploadBtn.classList.toggle('active', !camera);
        cameraView.classList.toggle('active', camera);
        uploadView.classList.toggle('active', !camera);
        clearLock();
        if (camera) {
            scanBtn.innerHTML = '<span class="btn-text">Scanning live…</span>';
            startCamera();
        } else {
            stopCamera();
            scanBtn.innerHTML = '<span class="btn-text">Read Image</span>';
            setStatus('Upload a photo or screenshot of a Qode.');
        }
    }

    async function startCamera() {
        if (activeStream) { startLive(); return; }
        try {
            activeStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
                audio: false,
            });
            videoFeed.srcObject = activeStream;
            await videoFeed.play().catch(() => {});
            cameraView.classList.add('live');
            if (scanBtn) scanBtn.innerHTML = '<span class="btn-text">Scanning live…</span>';
            setStatus('Point the camera at a Qode.');
            startLive();
        } catch (err) {
            console.error('Camera Error:', err);
            setStatus(location.protocol === 'https:' || location.hostname === 'localhost'
                ? 'Camera access denied. You can upload an image instead.'
                : 'The camera needs HTTPS. You can upload an image instead.');
        }
    }

    function stopCamera() {
        liveRunning = false;
        if (activeStream) {
            activeStream.getTracks().forEach((t) => t.stop());
            videoFeed.srcObject = null;
            activeStream = null;
        }
        cameraView.classList.remove('live');
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
        reads = [];
        readFrames = 0;
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
            if (loc.foundCount < 3) setStatus('Fit the whole Qode in view.');
            else if (!readable) setStatus('Move closer.');
            else setStatus(readFrames ? `Reading… (${readFrames} ${readFrames === 1 ? 'frame' : 'frames'})` : 'Reading…');
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
            if (isLocked || !r) return;
            if (!r.success) { if (tracking) readFrames++; return; }
            readFrames++;
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

    // --- Tracking overlay (canvas over the video, matching object-fit: cover) ---
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

    const COLORS = { tracking: '255, 197, 49', reading: '61, 160, 255', read: '62, 220, 132' };

    function drawOverlay() {
        const o = overlayContext();
        if (!o) return;
        const lost = !isLocked && performance.now() - seenAt > 350;
        if (!tracking || !tracking.outline) { shown = null; return; }
        const target = tracking.outline.map((p) => frameToView(p, tracking.fw, tracking.fh, o.cw, o.ch));
        // Ease toward the latest position so the frame glides instead of jumping
        shown = shown && shown.length === target.length
            ? shown.map((p, i) => ({ x: p.x + (target[i].x - p.x) * 0.45, y: p.y + (target[i].y - p.y) * 0.45 }))
            : target;
        const { ctx } = o;
        const color = COLORS[tracking.state] || COLORS.tracking;
        const alpha = lost ? 0.35 : 1;
        ctx.lineWidth = 3;
        ctx.strokeStyle = `rgba(${color}, ${0.95 * alpha})`;
        ctx.shadowColor = `rgba(${color}, ${0.8 * alpha})`;
        ctx.shadowBlur = 14;
        // While reading, the frame "scans" with a moving dash
        if (tracking.state === 'reading' && !lost) {
            ctx.setLineDash([14, 10]);
            ctx.lineDashOffset = -(performance.now() / 25) % 24;
        } else {
            ctx.setLineDash([]);
        }
        ctx.beginPath();
        shown.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
    }

    // --- Lock (result found) ---
    function lockScan(payload) {
        if (isLocked) return;
        isLocked = true;

        // Freeze the frame the text was read from
        if (snapPreview) {
            snapPreview.src = captureCanvas.toDataURL('image/jpeg', 0.85);
            snapPreview.classList.remove('hidden');
        }
        if (lockRing) lockRing.classList.remove('hidden');
        if (decodedText) decodedText.textContent = payload;
        if (decodedOverlay) decodedOverlay.classList.remove('hidden');

        const container = document.querySelector('.scanner-container.active');
        if (container) {
            container.classList.remove('snap-flash');
            void container.offsetWidth;
            container.classList.add('snap-flash', 'locked');
        }
        showResult(payload);
        setStatus('Qode read. Tap "Scan Again" for the next one.');
        if (scanBtn) scanBtn.innerHTML = '<span class="btn-text">Scan Again</span>';
        try { videoFeed.pause(); } catch (e) {}
        // Browsers only allow vibration after the person has tapped the page
        if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(120);
    }

    function clearLock() {
        isLocked = false;
        forgetCode();
        if (snapPreview) { snapPreview.classList.add('hidden'); snapPreview.src = ''; }
        if (lockRing) lockRing.classList.add('hidden');
        if (decodedOverlay) decodedOverlay.classList.add('hidden');
        if (decodedText) decodedText.textContent = '';
        if (resultBox) resultBox.classList.add('hidden');
        if (scanResult) scanResult.value = '';
        document.querySelectorAll('.scanner-container').forEach((c) => c.classList.remove('locked'));
        drawOverlay();
    }

    function resetLock() {
        clearLock();
        if (scanBtn) scanBtn.innerHTML = '<span class="btn-text">Scanning live…</span>';
        setStatus('Point the camera at a Qode.');
        try { videoFeed.play(); } catch (e) {}
        startLive();
    }

    function showResult(text) {
        if (scanResult) scanResult.value = text;
        if (resultBox) resultBox.classList.remove('hidden');
    }

    // --- Upload: decoded in the browser too ---
    async function readUpload(file) {
        setStatus('Reading image…');
        if (scanBtn) scanBtn.classList.add('loading');
        try {
            const url = URL.createObjectURL(file);
            const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
            const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
            const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
            captureCanvas.width = w;
            captureCanvas.height = h;
            const ctx = captureCanvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, w, h);
            URL.revokeObjectURL(url);
            // A single image gets no second read, so it must be clear on its own
            const result = (await reader.run('decode', ctx.getImageData(0, 0, w, h), { strictness: 1, minDiameter: 100 })) || {};
            if (result.success) {
                showResult(result.payload);
                setStatus('Qode read.');
            } else {
                const why = {
                    'No Qode anchors found': 'No Qode found in this image.',
                    'Move closer': 'The Qode is too small in this image. Crop closer or use a larger photo.',
                    'Need all anchors in view': 'Part of the Qode is cut off.',
                    'Could not read the dots yet': 'The Qode is too blurry or dark to read reliably.',
                }[result.reason];
                setStatus(why || 'Could not read this image.');
            }
        } catch (e) {
            setStatus('Could not open this image.');
        } finally {
            if (scanBtn) scanBtn.classList.remove('loading');
        }
    }

    if (scanBtn) {
        scanBtn.addEventListener('click', () => {
            if (cameraView && cameraView.classList.contains('active')) {
                if (isLocked) resetLock();
                else if (!activeStream) startCamera();
            } else if (fileInput && fileInput.files[0]) {
                readUpload(fileInput.files[0]);
            } else {
                setStatus('Upload an image first.');
            }
        });
    }

    if (copyBtn && scanResult) {
        copyBtn.addEventListener('click', async () => {
            if (!scanResult.value) return;
            try { await navigator.clipboard.writeText(scanResult.value); }
            catch (e) { scanResult.select(); document.execCommand('copy'); }
            const label = copyBtn.textContent;
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = label; }, 1500);
        });
    }

    if (dropzone && fileInput) {
        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            if (e.dataTransfer.files.length) { fileInput.files = e.dataTransfer.files; handleFileSelect(); }
        });
        fileInput.addEventListener('change', handleFileSelect);
        function handleFileSelect() {
            const file = fileInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                uploadPreview.src = e.target.result;
                uploadPreview.classList.remove('hidden');
                dropzone.classList.add('hidden');
            };
            reader.readAsDataURL(file);
            readUpload(file); // read straight away, no extra click
        }
    }

    // Stop the camera when the tab is hidden, resume when it comes back
    document.addEventListener('visibilitychange', () => {
        if (!isScannerPage || !cameraView.classList.contains('active')) return;
        if (document.hidden) stopCamera();
        else if (!isLocked) startCamera();
    });
});
