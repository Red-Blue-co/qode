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

    // --- Scanner Logic (With Auto-Scan & Snap) ---
    const cameraView = document.getElementById('camera-view');
    const uploadView = document.getElementById('upload-view');
    const modeCameraBtn = document.getElementById('mode-camera');
    const modeUploadBtn = document.getElementById('mode-upload');
    const videoFeed = document.getElementById('video-feed');
    const snapPreview = document.getElementById('scan-snap-preview');
    const captureCanvas = document.getElementById('capture-canvas');
    const scanBtn = document.getElementById('scan-btn');
    const resultBox = document.getElementById('result-box');
    const scanResult = document.getElementById('scan-result');
    const fileInput = document.getElementById('file-input');
    const dropzone = document.getElementById('dropzone');
    const uploadPreview = document.getElementById('uploaded-preview');
    const scanStatus = document.getElementById('scan-status');

    let activeStream = null;
    let scanInterval = null;
    let isScanning = false;

    // Mode Switching
    if (modeCameraBtn && modeUploadBtn) {
        modeCameraBtn.addEventListener('click', () => switchMode('camera'));
        modeUploadBtn.addEventListener('click', () => switchMode('upload'));

        if (window.location.href.includes('scanner.html')) {
            startCamera();
        }
    }

    function switchMode(mode) {
        if (mode === 'camera') {
            modeCameraBtn.classList.add('active');
            modeUploadBtn.classList.remove('active');
            cameraView.classList.add('active');
            uploadView.classList.remove('active');
            scanBtn.innerHTML = '<span class="btn-text">Scan Now</span>';
            clearLockUI();
            startCamera();
        } else {
            modeUploadBtn.classList.add('active');
            modeCameraBtn.classList.remove('active');
            uploadView.classList.add('active');
            cameraView.classList.remove('active');
            stopCamera();
            clearLockUI();
            scanBtn.innerHTML = '<span class="btn-text">Process File</span>';
        }
    }

    function clearLockUI() {
        isLocked = false;
        lastPayload = null;
        if (snapPreview) { snapPreview.classList.add('hidden'); snapPreview.src = ''; }
        const ring = document.getElementById('lock-ring');
        const ov = document.getElementById('decoded-overlay');
        const tx = document.getElementById('decoded-text');
        if (ring) ring.classList.add('hidden');
        if (ov) ov.classList.add('hidden');
        if (tx) tx.textContent = '';
        if (cameraView) cameraView.classList.remove('locked');
    }

    async function startCamera() {
        try {
            if (activeStream) return;
            activeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
            videoFeed.srcObject = activeStream;
            videoFeed.play();
            if (scanStatus) scanStatus.innerText = "Camera active. Point at a Qode.";
            startAutoScan();
        } catch (err) {
            console.error("Camera Error:", err);
            if (scanStatus) scanStatus.innerText = "Camera access denied.";
        }
    }

    function stopCamera() {
        stopAutoScan();
        if (activeStream) {
            activeStream.getTracks().forEach(track => track.stop());
            videoFeed.srcObject = null;
            activeStream = null;
        }
    }

    function startAutoScan() {
        if (scanInterval) clearInterval(scanInterval);
        isScanning = true;
        scanInterval = setInterval(() => {
            if (!isScanning) return;
            if (videoFeed.readyState === videoFeed.HAVE_ENOUGH_DATA) {
                captureFrameAndScan();
            }
        }, 500);
    }

    function stopAutoScan() {
        clearInterval(scanInterval);
        isScanning = false;
        if (scanBtn) scanBtn.classList.remove('loading');
    }

    const lockRing = document.getElementById('lock-ring');
    const decodedOverlay = document.getElementById('decoded-overlay');
    const decodedText = document.getElementById('decoded-text');
    let isLocked = false;
    let scanInFlight = false;
    let lastPayload = null; // require two consecutive identical decodes to lock

    async function captureFrameAndScan() {
        if (isLocked || scanInFlight) return;
        if (!videoFeed.videoWidth || !videoFeed.videoHeight) return;

        // Downscale to max 800 on longest side (bandwidth + CPU)
        const maxDim = 800;
        const ratio = Math.min(1, maxDim / Math.max(videoFeed.videoWidth, videoFeed.videoHeight));
        const targetW = Math.round(videoFeed.videoWidth * ratio);
        const targetH = Math.round(videoFeed.videoHeight * ratio);

        captureCanvas.width = targetW;
        captureCanvas.height = targetH;
        captureCanvas.getContext('2d').drawImage(videoFeed, 0, 0, targetW, targetH);

        scanInFlight = true;
        captureCanvas.toBlob(async (blob) => {
            if (!blob) { scanInFlight = false; return; }
            const formData = new FormData();
            formData.append('image', blob);

            try {
                const response = await fetch('/api/scan', { method: 'POST', body: formData });
                const data = await response.json();

                if (data.payload && data.meta && data.meta.aligned) {
                    if (lastPayload === data.payload) {
                        lockScan(data.payload);
                        lastPayload = null;
                    } else {
                        lastPayload = data.payload;
                        scanStatus.innerText = "Stabilizing Qode...";
                    }
                } else if (data.meta && data.meta.foundCount >= 2) {
                    lastPayload = null;
                    scanStatus.innerText = `Aligning Qode... (${data.meta.foundCount}/4 anchors)`;
                } else {
                    lastPayload = null;
                    scanStatus.innerText = "Scanning for Qodes...";
                }
            } catch (err) { /* transient network errors OK */ }
            finally { scanInFlight = false; }
        }, 'image/png');
    }

    function lockScan(payload) {
        if (isLocked) return;
        isLocked = true;

        // Freeze the scanned frame over the live video
        snapPreview.src = captureCanvas.toDataURL('image/png');
        snapPreview.classList.remove('hidden');

        // Show lock ring + decoded text overlay
        if (lockRing) lockRing.classList.remove('hidden');
        if (decodedText) decodedText.textContent = payload;
        if (decodedOverlay) decodedOverlay.classList.remove('hidden');

        // Flash the container
        const container = document.querySelector('.scanner-container.active');
        if (container) {
            container.classList.remove('snap-flash');
            void container.offsetWidth;
            container.classList.add('snap-flash');
            container.classList.add('locked');
        }

        // Side panel
        scanResult.value = payload;
        resultBox.classList.remove('hidden');
        scanStatus.innerText = "Qode locked. Move the camera freely.";
        if (scanBtn) scanBtn.innerHTML = '<span class="btn-text">Scan Again</span>';

        stopAutoScan();
        try { videoFeed.pause(); } catch (e) {}
        if (navigator.vibrate) navigator.vibrate(200);
    }

    function resetLock() {
        isLocked = false;
        lastPayload = null;
        snapPreview.classList.add('hidden');
        snapPreview.src = '';
        if (lockRing) lockRing.classList.add('hidden');
        if (decodedOverlay) decodedOverlay.classList.add('hidden');
        if (decodedText) decodedText.textContent = '';
        resultBox.classList.add('hidden');
        scanResult.value = "";
        const container = document.querySelector('.scanner-container.active');
        if (container) container.classList.remove('locked');
        scanBtn.innerHTML = '<span class="btn-text">Scan Now</span>';
        scanStatus.innerText = "Rescanning...";
        try { videoFeed.play(); } catch (e) {}
        startAutoScan();
    }

    if (scanBtn) {
        scanBtn.addEventListener('click', async () => {
            if (cameraView.classList.contains('active')) {
                if (isLocked) {
                    resetLock();
                } else {
                    if (!videoFeed.srcObject) return;
                    scanBtn.classList.add('loading');
                    await captureFrameAndScan();
                    scanBtn.classList.remove('loading');
                }
            } else {
                // Upload Mode
                if (!fileInput.files[0]) {
                    scanStatus.innerText = "Please upload an image first.";
                    return;
                }
                scanStatus.innerText = "Processing File...";
                scanBtn.classList.add('loading');
                const formData = new FormData();
                formData.append('image', fileInput.files[0]);
                try {
                    const response = await fetch('/api/scan', { method: 'POST', body: formData });
                    const data = await response.json();
                    scanBtn.classList.remove('loading');
                    if (data.payload) {
                        scanResult.value = data.payload;
                        resultBox.classList.remove('hidden');
                        scanStatus.innerText = "Qode Decoded.";
                    } else {
                        scanStatus.innerText = "No Qode found.";
                    }
                } catch (e) {
                    scanBtn.classList.remove('loading');
                    scanStatus.innerText = "Error processing file.";
                }
            }
        });
    }

    if (dropzone) {
        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            if (e.dataTransfer.files.length) {
                fileInput.files = e.dataTransfer.files;
                handleFileSelect();
            }
        });
        fileInput.addEventListener('change', handleFileSelect);
        function handleFileSelect() {
            const file = fileInput.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    uploadPreview.src = e.target.result;
                    uploadPreview.classList.remove('hidden');
                    dropzone.classList.add('hidden');
                };
                reader.readAsDataURL(file);
            }
        }
    }
});
