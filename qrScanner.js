"use strict";

const { createCanvas, loadImage } = require("canvas");
const QodeDecoder = require("./public/qode-decoder");

// Server-side wrapper around the same decoder the scanner page runs in the browser
// (public/qode-decoder.js), so /api/scan and live scanning always agree.
class RobustHexScanner {
    /**
     * @param {Object} options
     * @param {number} [options.eccLevel] Complexity used when the code was made (1-3).
     *   Leave it out to detect it automatically.
     */
    constructor(options = {}) {
        this.eccLevel = options.eccLevel;
    }

    async decodeFromBuffer(buffer) {
        try {
            const img = await loadImage(buffer);
            const canvas = createCanvas(img.width, img.height);
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            // A single uploaded image gets no second read, so it must be clear on its own
            return QodeDecoder.decode(ctx.getImageData(0, 0, img.width, img.height), {
                eccLevel: this.eccLevel,
                strictness: 1,
                minDiameter: 100,
            });
        } catch (err) {
            console.error("Scanner Error:", err);
            return { success: false, reason: err.message, meta: { aligned: false, foundCount: 0 } };
        }
    }
}

module.exports = RobustHexScanner;
