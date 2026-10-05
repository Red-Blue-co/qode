"use strict";

const { createCanvas, loadImage } = require("canvas");

class RobustHexScanner {
    /**
     * @param {Object} options
     * @param {number} options.eccLevel
     * 1 = Raw (1 trit per slot)
     * 2 = Standard (3x voting - Default)
     * 3 = Max Security (5x voting)
     */
    constructor(options = {}) {
        this.size = 500;
        this.step = 12;
        this.eccLevel = options.eccLevel || 2;

        // Generator anchor arc midpoint angles (must match qrCode.js)
        this.REF_ANCHOR_ANGLES = {
            red:    (225 * Math.PI) / 180, // 200-250 mid
            blue:   (315 * Math.PI) / 180, // 290-340 mid
            green:  ( 45 * Math.PI) / 180, // 20-70 mid
            yellow: (135 * Math.PI) / 180  // 110-160 mid
        };
        // Anchors are drawn at radius size*0.45 but span 50deg arcs, so the centroid
        // of detected colored pixels sits inward by sin(half)/half. Using the
        // centroid radius so scale resolves to 1.0 on a pristine generator image.
        const ARC_HALF = (25 * Math.PI) / 180;
        this.REF_ANCHOR_RADIUS = this.size * 0.45 * (Math.sin(ARC_HALF) / ARC_HALF);
    }

    getPointHash(x, y) {
        let h = Math.imul(x, 374761393);
        h = Math.imul(h ^ y, 668265263);
        h = Math.imul(h ^ (h >>> 15), 2246822519);
        h = h ^ (h >>> 13);
        return h >>> 0;
    }

    getRawGrid() {
        const grid = [];
        const cx = this.size / 2;
        const cy = this.size / 2;
        const radius = this.size * 0.40;
        const rowHeight = this.step * 0.866;
        let rowCount = 0;

        for (let y = 0; y < this.size; y += rowHeight) {
            const xOffset = (rowCount % 2 === 0) ? 0 : (this.step / 2);
            for (let x = -this.step; x < this.size + this.step; x += this.step) {
                const actualX = x + xOffset;
                const dist = Math.sqrt((actualX - cx) ** 2 + (y - cy) ** 2);
                if (dist < radius) grid.push({ x: actualX, y: y });
            }
            rowCount++;
        }
        grid.sort((a, b) => this.getPointHash(a.x, a.y) - this.getPointHash(b.x, b.y));
        return grid;
    }

    // --- COLOR ANCHOR LOCATOR (works on camera frames of any size) ---

    classifyColor(r, g, b) {
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const delta = max - min;
        // Brightness floor rejects anti-aliased dark edges (slate bg #0f172a has a
        // blue tint that otherwise creates false "blue" hits near every white dot).
        if (max < 120 || delta < 40) return null;
        const saturation = delta / max;
        if (saturation < 0.40) return null;

        let h;
        if (max === r)      h = (g - b) / delta;
        else if (max === g) h = (b - r) / delta + 2;
        else                h = (r - g) / delta + 4;
        h *= 60;
        if (h < 0) h += 360;

        if (h >= 340 || h < 20)  return 'red';
        if (h >= 35  && h < 70)  return 'yellow';
        if (h >= 90  && h < 170) return 'green';
        if (h >= 190 && h < 250) return 'blue';
        return null;
    }

    findAnchors(imageData, w, h) {
        const buckets = { red: [], blue: [], green: [], yellow: [] };
        const step = Math.max(1, Math.floor(Math.min(w, h) / 400));
        const data = imageData.data;

        for (let y = 0; y < h; y += step) {
            for (let x = 0; x < w; x += step) {
                const idx = (y * w + x) * 4;
                const color = this.classifyColor(data[idx], data[idx + 1], data[idx + 2]);
                if (color) buckets[color].push([x, y]);
            }
        }

        const anchors = {};
        for (const [name, pts] of Object.entries(buckets)) {
            if (pts.length < 8) continue;

            let sx = 0, sy = 0;
            for (const p of pts) { sx += p[0]; sy += p[1]; }
            const cx0 = sx / pts.length;
            const cy0 = sy / pts.length;

            // Reject outliers: keep points within 2x median distance from centroid.
            const dists = pts.map(p => Math.hypot(p[0] - cx0, p[1] - cy0));
            const sorted = [...dists].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)] || 1;
            const thresh = Math.max(median * 2 + 10, 15);

            let fx = 0, fy = 0, fn = 0;
            for (let i = 0; i < pts.length; i++) {
                if (dists[i] <= thresh) {
                    fx += pts[i][0]; fy += pts[i][1]; fn++;
                }
            }
            if (fn < 6) continue;
            anchors[name] = { x: fx / fn, y: fy / fn, count: fn };
        }
        return anchors;
    }

    computeTransform(anchors) {
        const have = (name) => anchors[name] != null;
        const hasRG = have('red') && have('green');
        const hasBY = have('blue') && have('yellow');
        if (!hasRG && !hasBY) return null;

        // Center: average midpoints of every complete opposite pair.
        let cx = 0, cy = 0, pairs = 0;
        if (hasRG) {
            cx += (anchors.red.x + anchors.green.x) / 2;
            cy += (anchors.red.y + anchors.green.y) / 2;
            pairs++;
        }
        if (hasBY) {
            cx += (anchors.blue.x + anchors.yellow.x) / 2;
            cy += (anchors.blue.y + anchors.yellow.y) / 2;
            pairs++;
        }
        cx /= pairs;
        cy /= pairs;

        // Scale: mean measured radius / reference centroid radius.
        // Rotation: circular mean of per-anchor angle deltas.
        const names = Object.keys(anchors);
        let totalDist = 0, sinSum = 0, cosSum = 0;
        for (const name of names) {
            const a = anchors[name];
            const dx = a.x - cx;
            const dy = a.y - cy;
            totalDist += Math.hypot(dx, dy);
            const delta = Math.atan2(dy, dx) - this.REF_ANCHOR_ANGLES[name];
            sinSum += Math.sin(delta);
            cosSum += Math.cos(delta);
        }
        const avgDist = totalDist / names.length;
        const scale = avgDist / this.REF_ANCHOR_RADIUS;
        const rotation = Math.atan2(sinSum, cosSum);

        if (!isFinite(scale) || scale <= 0.02) return null;
        return { cx, cy, scale, rotation };
    }

    // --- TERNARY DECODE HELPERS (preserve the generator's protocol) ---

    ternaryToText(trits) {
        let text = "";
        for (let i = 0; i < trits.length; i += 5) {
            const chunk = trits.substring(i, i + 5);
            if (chunk.length < 5) break;
            const val = parseInt(chunk, 3);
            if (val === 0) break;
            if (val >= 32 && val <= 126) text += String.fromCharCode(val);
        }
        return text;
    }

    getMode(chunk) {
        const counts = { '0': 0, '1': 0, '2': 0 };
        for (const ch of chunk) counts[ch]++;
        return Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
    }

    async decodeFromBuffer(buffer) {
        try {
            const img = await loadImage(buffer);
            const w = img.width;
            const h = img.height;
            const canvas = createCanvas(w, h);
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, w, h);
            const data = imageData.data;

            // 1. Locate the Qode by its 4 colored arc anchors anywhere in the frame.
            const anchors = this.findAnchors(imageData, w, h);
            const foundCount = Object.keys(anchors).length;

            const xform = this.computeTransform(anchors);
            if (!xform) {
                return {
                    success: false,
                    reason: foundCount < 2 ? "No Qode anchors found" : "Need opposite anchor pair",
                    meta: { aligned: false, foundCount, score: 0, ecc: this.eccLevel }
                };
            }

            // 2. Build a mapping from reference 500x500 grid coords to image coords.
            const refCx = this.size / 2;
            const refCy = this.size / 2;
            const cosR = Math.cos(xform.rotation);
            const sinR = Math.sin(xform.rotation);
            const toImage = (px, py) => {
                const dx = px - refCx;
                const dy = py - refCy;
                const rx = dx * cosR - dy * sinR;
                const ry = dx * sinR + dy * cosR;
                return {
                    x: rx * xform.scale + xform.cx,
                    y: ry * xform.scale + xform.cy
                };
            };

            const getBrightness = (x, y) => {
                if (x < 0 || x >= w || y < 0 || y >= h) return 0;
                const idx = (Math.floor(y) * w + Math.floor(x)) * 4;
                return (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
            };

            // Generator rim sits ~3px from center in reference space; scale it to
            // image-space so the check works for any-size inputs (camera frames).
            const rimOffset = Math.max(2, 3 * xform.scale);
            const threshold = 70;

            // 3. Sample each grid slot with 3-state (empty / hollow / filled) detection.
            const rawGrid = this.getRawGrid();
            let rawTrits = "";
            for (const p of rawGrid) {
                const ip = toImage(p.x, p.y);
                const centerVal = getBrightness(ip.x, ip.y);
                const avgRim = (
                    getBrightness(ip.x + rimOffset, ip.y) +
                    getBrightness(ip.x - rimOffset, ip.y) +
                    getBrightness(ip.x, ip.y + rimOffset) +
                    getBrightness(ip.x, ip.y - rimOffset)
                ) / 4;

                if (centerVal > threshold) rawTrits += "2";
                else if (avgRim > threshold) rawTrits += "1";
                else rawTrits += "0";
            }

            // 4. Trit-level voting (matches generator's per-trit repetition).
            const voteSize = (this.eccLevel === 2) ? 3 : (this.eccLevel === 3 ? 5 : 1);
            let cleanTrits = "";
            for (let i = 0; i < rawTrits.length; i += voteSize) {
                const chunk = rawTrits.substring(i, i + voteSize);
                if (chunk.length < voteSize) break;
                cleanTrits += this.getMode(chunk);
            }

            const text = this.ternaryToText(cleanTrits);

            return {
                success: true,
                payload: text,
                meta: {
                    method: "color_locator_ternary",
                    rotation: xform.rotation,
                    scale: xform.scale,
                    center: { x: xform.cx, y: xform.cy },
                    ecc: this.eccLevel,
                    aligned: foundCount === 4 && text.length > 0,
                    foundCount,
                    score: foundCount * 25
                }
            };
        } catch (err) {
            console.error("Scanner Error:", err);
            return {
                success: false,
                reason: err.message,
                meta: { aligned: false, foundCount: 0, ecc: this.eccLevel }
            };
        }
    }
}

module.exports = RobustHexScanner;
