"use strict";

const { createCanvas } = require("canvas");
const QodeFormat = require("./public/qode-format");

class HexGenerator {
    /**
     * @param {Object} options Configuration object
     * @param {string} options.shape 'cir' (default), 'sq', or 'hex'
     * @param {number} options.eccLevel 
     * 1 = Raw (High Cap - 1 dot per trit)
     * 2 = Standard (3x Vote - 3 dots per trit - Default)
     * 3 = Max Security (5x Vote - 5 dots per trit)
     */
    constructor(options = {}) {
        this.size = 500;
        
        // --- 1. CONFIGURABLE PARAMETERS ---
        this.shape = options.shape || 'cir'; 
        this.eccLevel = options.eccLevel || 2; 
        
        // Standard Settings
        this.step = 12;
        this.dotRadius = 4; // Radius of the dot itself

        this.ANCHORS = [
            { color: "#ef4444", start: 200, end: 250, type: "solid" },   // Red (Solid)
            { color: "#3b82f6", start: 290, end: 340, type: "dotted" },
            { color: "#22c55e", start: 20,  end: 70,  type: "dashed" },
            { color: "#facc15", start: 110, end: 160, type: "double" }
        ];
    }

    // Characters (UTF-8 bytes) that fit at this strength
    estimateCapacity() {
        return QodeFormat.capacity(this.eccLevel);
    }

    getGrid() {
        return QodeFormat.grid();
    }

    drawAnchors(ctx) {
        const cx = this.size / 2;
        const cy = this.size / 2;
        const anchorRadius = this.size * 0.45;
        const borderRadius = this.size * 0.425;

        ctx.beginPath();
        ctx.arc(cx, cy, borderRadius, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#ffffff";
        ctx.setLineDash([]);
        ctx.stroke();

        ctx.lineCap = "round";

        for (let a of this.ANCHORS) {
            ctx.save();
            ctx.strokeStyle = a.color;
            const start = (a.start * Math.PI) / 180;
            const end = (a.end * Math.PI) / 180;

            ctx.beginPath();
            if (a.type === "double") {
                ctx.lineWidth = 3; 
                ctx.setLineDash([]);
                ctx.arc(cx, cy, anchorRadius - 3.5, start, end);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(cx, cy, anchorRadius + 3.5, start, end);
            } 
            else {
                ctx.lineWidth = 10;
                if (a.type === "dotted") ctx.setLineDash([0, 15]);
                else if (a.type === "dashed") ctx.setLineDash([15, 15]);
                else ctx.setLineDash([]);
                ctx.arc(cx, cy, anchorRadius, start, end);
            }
            ctx.stroke();
            ctx.restore();
        }
    }

    // --- UPDATED DRAW DOT (3 STATES) ---
    /**
    /**
     * @param {CanvasRenderingContext2D} ctx 
     * @param {number} x 
     * @param {number} y 
     * @param {string} val '0' (Empty), '1' (Hollow), '2' (Full)
     */
    drawDot(ctx, x, y, val) {
        // REMOVED: if (val === '0') return; -> Now we draw '0' too!

        ctx.beginPath();

        // 1. CHOOSE SHAPE PATH
        if (this.shape === 'sq') {
            const d = this.dotRadius * 2;
            ctx.rect(x - this.dotRadius, y - this.dotRadius, d, d);
        } 
        else if (this.shape === 'hex') {
            for (let i = 0; i < 6; i++) {
                const angle = (Math.PI / 3) * i;
                const px = x + this.dotRadius * Math.cos(angle);
                const py = y + this.dotRadius * Math.sin(angle);
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.closePath();
        } 
        else {
            ctx.arc(x, y, this.dotRadius, 0, Math.PI * 2);
        }

        // 2. APPLY STYLE BASED ON VALUE
        if (val === '2') {
            // FULL (Bright Center) -> Data: 2
            ctx.fillStyle = "#FFFFFF";
            ctx.fill();
        } 
        else if (val === '1') {
            // HOLLOW (Bright Rim, Dark Center) -> Data: 1
            ctx.strokeStyle = "#FFFFFF"; 
            ctx.lineWidth = 1.5;         
            ctx.stroke();
        } 
        else {
            // EMPTY (Dark Rim, Dark Center) -> Data: 0
            // We use a very faint gray so humans see it, but scanner ignores it.
            // Brightness must remain < 50 for the scanner!
            ctx.strokeStyle = "#334155"; // Slate-700 (Dark Gray)
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    }

    async generateImageBuffer(text) {
        try {
            const canvas = createCanvas(this.size, this.size);
            const ctx = canvas.getContext("2d");

            // Dark Background
            ctx.fillStyle = "#0f172a";
            ctx.fillRect(0, 0, this.size, this.size);

            this.drawAnchors(ctx);

            // One bit per dot: the text with Reed-Solomon error correction (see public/qode-format.js)
            const bits = QodeFormat.encode(text, this.eccLevel);
            const grid = this.getGrid();
            if (Buffer.byteLength(text, "utf8") > this.estimateCapacity()) {
                console.warn("Text too long for this strength, it will be cut short.");
            }
            for (let i = 0; i < grid.length; i++) {
                this.drawDot(ctx, grid[i].x, grid[i].y, bits[i] ? '2' : '0');
            }

            return canvas.toBuffer("image/png");

        } catch (err) {
            console.error("Generator Error:", err);
            throw err;
        }
    }
}

module.exports = HexGenerator;