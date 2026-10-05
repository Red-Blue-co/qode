/*
 * QODE decoder: finds a Qode in raw RGBA pixels and reads its text.
 * Runs unchanged in the browser (window / Web Worker) and in Node (server.js).
 *
 *   QodeDecoder.decode({ data, width, height }, { eccLevel })  ->  result
 *
 * Steps: locate the four coloured arc anchors, map the reference 500x500 layout
 * onto the image (perspective when all four are seen), measure every dot, learn the
 * three dot states (empty / ring / filled) from the image itself, vote, and only
 * report text that passes the checks, so a bad frame says "not found" instead of
 * returning wrong text.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QodeDecoder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- Layout shared with the generator (qrCode.js) ---
  const SIZE = 500;
  const STEP = 12;
  const ANCHOR_RADIUS = SIZE * 0.45;
  const ARC_HALF = (25 * Math.PI) / 180;
  // Pixels of a 50° arc average out slightly inside its radius
  const ANCHOR_CENTROID_R = ANCHOR_RADIUS * (Math.sin(ARC_HALF) / ARC_HALF);
  const ANCHOR_ANGLE = { red: 225, blue: 315, green: 45, yellow: 135 };
  const OPPOSITE = { red: 'green', green: 'red', blue: 'yellow', yellow: 'blue' };
  const NAMES = ['red', 'blue', 'green', 'yellow'];

  function pointHash(x, y) {
    let h = Math.imul(x, 374761393);
    h = Math.imul(h ^ y, 668265263);
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h = h ^ (h >>> 13);
    return h >>> 0;
  }

  // Dot positions in the generator's (hash-shuffled) data order
  let gridCache = null;
  function dataGrid() {
    if (gridCache) return gridCache;
    const grid = [];
    const c = SIZE / 2;
    const radius = SIZE * 0.40;
    const rowHeight = STEP * 0.866;
    let row = 0;
    for (let y = 0; y < SIZE; y += rowHeight) {
      const off = row % 2 === 0 ? 0 : STEP / 2;
      for (let x = -STEP; x < SIZE + STEP; x += STEP) {
        const ax = x + off;
        if (Math.hypot(ax - c, y - c) < radius) grid.push({ x: ax, y });
      }
      row++;
    }
    grid.sort((a, b) => pointHash(a.x, a.y) - pointHash(b.x, b.y));
    gridCache = grid;
    return grid;
  }

  function refAnchor(name) {
    const a = (ANCHOR_ANGLE[name] * Math.PI) / 180;
    return { x: SIZE / 2 + ANCHOR_CENTROID_R * Math.cos(a), y: SIZE / 2 + ANCHOR_CENTROID_R * Math.sin(a) };
  }

  // --- 1. Anchor detection (adapts to exposure) ---

  function hueName(r, g, b, floor) {
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (max < floor) return null;
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const delta = max - min;
    if (delta < 22 || delta < max * 0.38) return null;
    let h;
    if (max === r) h = (g - b) / delta;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
    if (h >= 340 || h < 18) return 'red';
    if (h >= 36 && h < 72) return 'yellow';
    if (h >= 95 && h < 165) return 'green';
    if (h >= 200 && h < 245) return 'blue';
    return null;
  }

  function findAnchors(img) {
    const { data, width: w, height: h } = img;
    const minDim = Math.min(w, h);
    const stride = Math.max(1, Math.floor(minDim / 520));

    // Exposure: scale the brightness floor to the frame (dim rooms still work)
    const hist = new Uint32Array(256);
    let n = 0;
    for (let y = 0; y < h; y += stride * 4) {
      for (let x = 0; x < w; x += stride * 4) {
        const i = (y * w + x) * 4;
        hist[Math.max(data[i], data[i + 1], data[i + 2])]++;
        n++;
      }
    }
    let acc = 0, p98 = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.98) { p98 = v; break; } }
    const floor = Math.max(28, Math.min(115, p98 * 0.42));

    const pts = { red: [], blue: [], green: [], yellow: [] };
    for (let y = 0; y < h; y += stride) {
      for (let x = 0; x < w; x += stride) {
        const i = (y * w + x) * 4;
        const name = hueName(data[i], data[i + 1], data[i + 2], floor);
        if (name) pts[name].push(x, y);
      }
    }

    // Densest blob per colour, then refine its centre (ignores stray coloured pixels)
    const cell = Math.max(4, minDim / 28);
    const anchors = {};
    for (const name of NAMES) {
      const p = pts[name];
      const count = p.length / 2;
      if (count < 6) continue;
      const grid = new Map();
      let best = null, bestN = 0;
      for (let k = 0; k < p.length; k += 2) {
        const key = Math.floor(p[k] / cell) + ',' + Math.floor(p[k + 1] / cell);
        const v = (grid.get(key) || 0) + 1;
        grid.set(key, v);
        if (v > bestN) { bestN = v; best = key; }
      }
      const [gx, gy] = best.split(',').map(Number);
      let cx = (gx + 0.5) * cell, cy = (gy + 0.5) * cell;
      let radius = cell * 3.5, fn = 0;
      for (let iter = 0; iter < 4; iter++) {
        let sx = 0, sy = 0, s2 = 0;
        fn = 0;
        for (let k = 0; k < p.length; k += 2) {
          const dx = p[k] - cx, dy = p[k + 1] - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 <= radius * radius) { sx += p[k]; sy += p[k + 1]; s2 += d2; fn++; }
        }
        if (fn < 5) break;
        cx = sx / fn; cy = sy / fn;
        radius = Math.max(cell, 2.6 * Math.sqrt(s2 / fn));
      }
      if (fn >= 5) anchors[name] = { x: cx, y: cy, count: fn };
    }
    return anchors;
  }

  // --- 2. Reference -> image mappings ---

  function solve(A, b) { // Gaussian elimination with partial pivoting
    const n = b.length;
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-10) return null;
      [A[c], A[piv]] = [A[piv], A[c]];
      [b[c], b[piv]] = [b[piv], b[c]];
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
      x[r] = s / A[r][r];
    }
    return x;
  }

  function homography(src, dst) { // 4 point pairs -> 3x3 (h33 = 1)
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i], { x: u, y: v } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    if (!h) return null;
    return (px, py) => {
      const d = h[6] * px + h[7] * py + 1;
      return { x: (h[0] * px + h[1] * py + h[2]) / d, y: (h[3] * px + h[4] * py + h[5]) / d };
    };
  }

  function affine(src, dst) { // 3 point pairs
    const A = [], b = [];
    for (let i = 0; i < 3; i++) {
      const { x, y } = src[i];
      A.push([x, y, 1, 0, 0, 0]); b.push(dst[i].x);
      A.push([0, 0, 0, x, y, 1]); b.push(dst[i].y);
    }
    const m = solve(A, b);
    if (!m) return null;
    return (px, py) => ({ x: m[0] * px + m[1] * py + m[2], y: m[3] * px + m[4] * py + m[5] });
  }

  function similarity(anchors, names) { // centre + scale + rotation from opposite pairs
    let cx = 0, cy = 0, pairs = 0;
    for (const [a, b] of [['red', 'green'], ['blue', 'yellow']]) {
      if (names.includes(a) && names.includes(b)) {
        cx += (anchors[a].x + anchors[b].x) / 2; cy += (anchors[a].y + anchors[b].y) / 2; pairs++;
      }
    }
    if (!pairs) return null;
    cx /= pairs; cy /= pairs;
    let dist = 0, sin = 0, cos = 0;
    for (const n of names) {
      const dx = anchors[n].x - cx, dy = anchors[n].y - cy;
      dist += Math.hypot(dx, dy);
      const d = Math.atan2(dy, dx) - (ANCHOR_ANGLE[n] * Math.PI) / 180;
      sin += Math.sin(d); cos += Math.cos(d);
    }
    const scale = dist / names.length / ANCHOR_CENTROID_R;
    if (!(scale > 0.02)) return null;
    const rot = Math.atan2(sin, cos), cr = Math.cos(rot), sr = Math.sin(rot);
    return (px, py) => {
      const dx = px - SIZE / 2, dy = py - SIZE / 2;
      return { x: (dx * cr - dy * sr) * scale + cx, y: (dx * sr + dy * cr) * scale + cy };
    };
  }

  // Candidate mappings, most precise first
  function mappings(anchors) {
    const found = NAMES.filter((n) => anchors[n]);
    const out = [];
    const ref = (ns) => ns.map(refAnchor);
    const img = (ns) => ns.map((n) => anchors[n]);
    if (found.length === 4) {
      const H = homography(ref(found), img(found));
      if (H) out.push({ map: H, kind: 'perspective' });
    }
    if (found.length >= 3) {
      // Every set of three anchors (just one set when only three are in view)
      const sets = found.length === 3 ? [found] : found.map((_, skip) => found.filter((__, i) => i !== skip));
      for (const ns of sets) {
        const A = affine(ref(ns), img(ns));
        if (A) out.push({ map: A, kind: 'affine' });
      }
    }
    if (found.length >= 2) {
      const S = similarity(anchors, found);
      if (S) out.push({ map: S, kind: 'similarity' });
    }
    return out;
  }

  // --- 3. Measuring dots ---

  function sampler(img) {
    const { data, width: w, height: h } = img;
    return (x, y) => { // bilinear luminance
      if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return 0;
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const i = (y0 * w + x0) * 4, j = i + w * 4;
      const L = (k) => 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
      const top = L(i) * (1 - fx) + L(i + 4) * fx;
      const bot = L(j) * (1 - fx) + L(j + 4) * fx;
      return top * (1 - fy) + bot * fy;
    };
  }

  const RING = [], NEAR = [], GAP = [];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    RING.push([4.0 * Math.cos(a), 4.0 * Math.sin(a)]);
    GAP.push([6.2 * Math.cos(a), 6.2 * Math.sin(a)]);
  }
  for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; NEAR.push([1.1 * Math.cos(a), 1.1 * Math.sin(a)]); }

  // Area-weighted samples over a whole dot (out to just short of the gap). Blur
  // spreads a dot's light but keeps its total, so this tells the states apart even
  // when rings and filled dots look alike: filled ~2x a ring, empty close to none.
  const DISC = [];
  {
    const radii = [0, 1.3, 2.6, 3.7, 4.6, 5.4], counts = [1, 6, 10, 14, 18, 20];
    const edges = [0, 0.65, 1.95, 3.15, 4.15, 5.0, 5.8];
    radii.forEach((rad, j) => {
      const w = (Math.PI * (edges[j + 1] ** 2 - edges[j] ** 2)) / counts[j];
      for (let k = 0; k < counts[j]; k++) {
        const a = (k / counts[j]) * Math.PI * 2 + j * 0.37;
        DISC.push([rad * Math.cos(a), rad * Math.sin(a), w]);
      }
    });
  }

  function measure(img, map) {
    const lum = sampler(img);
    const grid = dataGrid();
    const at = (p, o) => { const q = map(p.x + o[0], p.y + o[1]); return lum(q.x, q.y); };
    const feats = new Array(grid.length);
    for (let i = 0; i < grid.length; i++) {
      const p = grid[i];
      let c = 2 * at(p, [0, 0]);
      for (const o of NEAR) c += at(p, o);
      c /= NEAR.length + 2;
      let r = 0, g = 0, e = 0, ew = 0;
      for (const o of RING) r += at(p, o);
      for (const o of GAP) g += at(p, o);
      for (const o of DISC) { e += o[2] * at(p, o); ew += o[2]; }
      feats[i] = { c, r: r / RING.length, e: e / ew, bg: g / GAP.length };
    }
    return feats;
  }

  // Learn empty / ring / filled from this image itself. Main measure: a dot's total
  // light (blur cannot change it: empty ~0, ring ~half, filled = full). Second
  // measure: brightness right at the centre (rings are dark there when sharp).
  function classify(feats) {
    // Background: blur lets a dot's own light spill into the gap right beside it, so
    // never trust a dot's surroundings to be darker than the code's typical background
    const bgs = feats.map((f) => f.bg).sort((a, b) => a - b);
    const bgTypical = bgs[Math.floor(bgs.length / 2)];
    const bgOf = (f) => Math.min(f.bg, bgTypical + 0.25 * Math.max(0, f.bg - bgTypical));
    // White levels: typical of the brightest few dots (a short code may fill only ~1%)
    const topLevel = (vals) => {
      const s = vals.map((v) => Math.max(0, v)).sort((a, b) => b - a);
      const t = s.slice(0, Math.max(3, Math.ceil(s.length * 0.01)));
      return t[Math.floor(t.length / 2)] || 0;
    };
    const eRaw = feats.map((f) => f.e - bgOf(f));
    const cRaw = feats.map((f) => f.c - bgOf(f));
    const whiteE = topLevel(eRaw), whiteC = topLevel(cRaw);
    if (whiteE < 6 || whiteC < 12) return null; // no contrast: not a Qode, or far too dark
    const x = eRaw.map((v) => v / whiteE); // total light
    const y = cRaw.map((v) => v / whiteC); // centre

    // 1. Three levels of total light (start: most dots empty, brightest filled)
    const sorted = [...x].sort((a, b) => a - b);
    let m = [sorted[Math.floor(sorted.length / 2)], 0, 1];
    m[1] = (m[0] + m[2]) / 2;
    const label = new Uint8Array(x.length);
    for (let it = 0; it < 12; it++) {
      const sum = [0, 0, 0], n = [0, 0, 0];
      for (let i = 0; i < x.length; i++) {
        let k = 0;
        for (let j = 1; j < 3; j++) if (Math.abs(x[i] - m[j]) < Math.abs(x[i] - m[k])) k = j;
        label[i] = k; sum[k] += x[i]; n[k]++;
      }
      m = m.map((v, k) => (n[k] ? sum[k] / n[k] : v));
    }
    if (m[2] - m[0] < 0.35) return null; // no clear filled dots
    // A code may have no '1' dots: only keep rings if they really stand apart
    if (m[1] - m[0] < 0.12 || m[2] - m[1] < 0.12) {
      for (let i = 0; i < label.length; i++) if (label[i] === 1) label[i] = x[i] - m[0] < m[2] - x[i] ? 0 : 2;
    }

    // 2. Refine on total light and centre together (starts from this image's groups)
    const prototypes = () => {
      const sum = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (let i = 0; i < label.length; i++) { const s = sum[label[i]]; s[0] += x[i]; s[1] += y[i]; s[2]++; }
      return sum.map((s) => (s[2] ? [s[0] / s[2], s[1] / s[2]] : null));
    };
    let proto = prototypes();
    if (!proto[0] || !proto[2]) return null;
    for (let it = 0; it < 6; it++) {
      let moved = 0;
      for (let i = 0; i < label.length; i++) {
        let best = label[i], bd = Infinity;
        for (let k = 0; k < 3; k++) {
          if (!proto[k]) continue;
          const d = (x[i] - proto[k][0]) ** 2 + (y[i] - proto[k][1]) ** 2;
          if (d < bd) { bd = d; best = k; }
        }
        if (best !== label[i]) { label[i] = best; moved++; }
      }
      proto = prototypes();
      if (!moved || !proto[0] || !proto[2]) break;
    }
    if (!proto[0] || !proto[2]) return null;
    // Meanings must hold: filled brightest overall, rings in between
    if (proto[1] && !(proto[2][0] > proto[1][0] && proto[1][0] > proto[0][0])) return null;
    if (!proto[1]) proto[1] = [(proto[0][0] + proto[2][0]) / 2, proto[0][1] + 0.6]; // no rings seen: keep the state far away

    let sq = 0;
    for (let i = 0; i < label.length; i++) {
      const p = proto[label[i]];
      sq += (x[i] - p[0]) ** 2 + (y[i] - p[1]) ** 2;
    }
    const variance = Math.max(0.004, sq / (2 * label.length));
    return { label, x, y, proto, variance };
  }

  // --- 4. Soft votes, text and checks ---

  // Evidence for each state, summed over a dot's copies (log-likelihood, shared spread)
  function voteGroup(dots, from, n) {
    const L = [0, 0, 0];
    for (let i = from; i < from + n; i++) {
      for (let k = 0; k < 3; k++) {
        const p = dots.proto[k];
        L[k] -= ((dots.x[i] - p[0]) ** 2 + (dots.y[i] - p[1]) ** 2) / (2 * dots.variance);
      }
    }
    let best = 0;
    for (let k = 1; k < 3; k++) if (L[k] > L[best]) best = k;
    let second = -Infinity;
    for (let k = 0; k < 3; k++) if (k !== best && L[k] > second) second = L[k];
    return { trit: best, margin: L[best] - second };
  }

  function readText(dots, ecc) {
    const vote = ecc === 1 ? 1 : ecc === 3 ? 5 : 3;
    const n = dots.label.length;
    let lastInk = -1; // last dot that is not empty
    for (let i = n - 1; i >= 0; i--) if (dots.label[i] !== 0) { lastInk = i; break; }

    let text = '', minMargin = Infinity, digits = [];
    for (let g = 0; (g + 1) * vote <= n; g++) {
      const v = voteGroup(dots, g * vote, vote);
      if (v.margin < minMargin) minMargin = v.margin;
      digits.push(v.trit);
      if (digits.length < 5) continue;
      const code = digits.reduce((acc, d) => acc * 3 + d, 0);
      digits = [];
      if (code === 0) {
        const used = (g + 1) * vote;
        // The real message must reach to where the dots turn empty; reading with the
        // wrong complexity stops early on a chance "terminator".
        if (lastInk >= used) return { text, ended: false, bad: true, ecc };
        // With the right complexity a digit's copies nearly always look alike; grouped
        // the wrong way they are unrelated dots. Only groups with ink count: empty
        // padding agrees with itself under any grouping.
        if (vote > 1) {
          let same = 0, inked = 0;
          for (let s = 0; s < used; s += vote) {
            let ok = true, ink = false;
            for (let k = 0; k < vote; k++) {
              if (dots.label[s + k] !== 0) ink = true;
              if (k && dots.label[s + k] !== dots.label[s]) ok = false;
            }
            if (!ink) continue;
            inked++;
            if (ok) same++;
          }
          if (!inked || same / inked < 0.8) return { text, ended: false, bad: true, ecc };
        }
        return { text, ended: true, minMargin, ecc };
      }
      if (code < 32 || code > 126) return { text, ended: false, bad: true, ecc };
      text += String.fromCharCode(code);
    }
    return { text, ended: false, ecc };
  }

  // How clear the least clear digit must be, per complexity (calibrated on randomised
  // photo distortions: with these, codes with copies never came back wrong). Codes
  // without copies (complexity 1) cannot check themselves, so a misread there can look
  // as clear as a good one; their bar is a compromise.
  const NEED = { 1: 20, 2: 12, 3: 40 };

  // Every digit of the message (and its terminator) must be clearly one state
  function accept(r, strictness) {
    return r.ended && !r.bad && r.text.length > 0 && r.minMargin >= NEED[r.ecc] * strictness;
  }

  // --- 5. Locate and read ---

  function outlineOf(map) { // the code's outer circle in image space, for overlays
    const pts = [];
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      pts.push(map(SIZE / 2 + ANCHOR_RADIUS * Math.cos(a), SIZE / 2 + ANCHOR_RADIUS * Math.sin(a)));
    }
    return pts;
  }

  function geometry(map) {
    const center = map(SIZE / 2, SIZE / 2);
    let span = 0;
    for (const deg of [0, 90, 180, 270]) {
      const a = (deg * Math.PI) / 180, q = map(SIZE / 2 + ANCHOR_RADIUS * Math.cos(a), SIZE / 2 + ANCHOR_RADIUS * Math.sin(a));
      span += Math.hypot(q.x - center.x, q.y - center.y);
    }
    return { center, diameter: (span / 4) * 2 };
  }

  // Cheap: is there a code, and where? Fast enough for every camera frame.
  function locate(img) {
    const anchors = findAnchors(img);
    const foundCount = Object.keys(anchors).length;
    const maps = foundCount >= 2 ? mappings(anchors) : [];
    if (!maps.length) return { found: false, foundCount, anchors };
    const g = geometry(maps[0].map);
    return { found: true, foundCount, anchors, maps, center: g.center, diameter: g.diameter, outline: outlineOf(maps[0].map) };
  }

  // Read text from dot measurements
  function readFeats(feats, opts, kind) {
    const dots = classify(feats);
    if (!dots) return null;
    const strictness = opts.strictness ?? 1;
    let best = null;
    for (const ecc of opts.eccLevel ? [opts.eccLevel] : [2, 3, 1]) {
      const r = readText(dots, ecc);
      if (!accept(r, strictness)) continue;
      // Prefer more copies per digit, then the clearest reading
      const bonus = kind === 'perspective' ? 0.1 : 0;
      const score = r.minMargin / NEED[ecc] + ecc + bonus;
      if (!best || score > best.score) best = { ...r, score, kind };
    }
    return best;
  }

  function success(best, loc, map) {
    const g = map ? geometry(map) : { center: loc.center, diameter: loc.diameter };
    return {
      success: true,
      payload: best.text,
      meta: {
        foundCount: loc.foundCount,
        anchors: loc.anchors,
        aligned: true,
        method: best.kind,
        ecc: best.ecc,
        margin: Math.round(best.minMargin * 10) / 10,
        confidence: Math.round(Math.min(1, best.minMargin / (NEED[best.ecc] * 4)) * 100) / 100,
        diameter: g.diameter,
        center: g.center,
        outline: map ? outlineOf(map) : loc.outline,
      },
    };
  }

  function failure(reason, loc) {
    const meta = { foundCount: loc.foundCount, anchors: loc.anchors, aligned: false };
    if (loc.found) Object.assign(meta, { diameter: loc.diameter, center: loc.center, outline: loc.outline });
    return { success: false, reason, meta };
  }

  // One image: try each way of mapping the layout onto it and keep the clearest read.
  // Live scanning calls this on successive camera frames and waits for two to agree.
  function decode(img, opts = {}) {
    const loc = locate(img);
    if (!loc.found) return failure(loc.foundCount < 2 ? 'No Qode anchors found' : 'Need all anchors in view', loc);
    if (loc.diameter < (opts.minDiameter || 120)) return failure('Move closer', loc);

    let best = null, bestMap = null;
    for (const m of loc.maps) {
      const r = readFeats(measure(img, m.map), opts, m.kind);
      if (r && (!best || r.score > best.score)) { best = r; bestMap = m.map; }
      if (best && best.minMargin >= NEED[best.ecc] * 3) break; // clear enough, skip weaker mappings
    }
    if (!best) return failure(loc.foundCount < 4 ? 'Need all anchors in view' : 'Could not read the dots yet', loc);
    return success(best, loc, bestMap);
  }

  return { decode, locate, findAnchors, _internals: { mappings, measure, classify, dataGrid } };
});
