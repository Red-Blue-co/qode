const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const HexGenerator = require('./qrCode');
const RobustHexScanner = require('./qrScanner');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Serve static files from 'public'
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- API: GENERATE ---
app.get('/api/generate', async (req, res) => {
    try {
        const text = req.query.text || "Hello Qode";
        const ecc = parseInt(req.query.ecc) || 2;
        console.log(`[API] Generating for: "${text}" (ECC: ${ecc})`);

        const generator = new HexGenerator({ eccLevel: ecc, shape: 'cir' });
        const buffer = await generator.generateImageBuffer(text);

        res.set('Content-Type', 'image/png');
        res.send(buffer);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// --- API: SCAN ---
app.post('/api/scan', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No image uploaded" });
        }
        console.log(`[API] Scanning image size: ${req.file.size} bytes`);

        const scanner = new RobustHexScanner(); // complexity is detected from the image
        const result = await scanner.decodeFromBuffer(req.file.buffer);

        res.json(result);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Start Server on Port (Render/Heroku/Local)
const PORT = process.env.PORT || 3002;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Qode Server running at http://localhost:${PORT}`);
});
