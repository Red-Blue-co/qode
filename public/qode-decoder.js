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
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./qode-format'));
  else root.QodeDecoder = factory(root.QodeFormat);
})(typeof self !== 'undefined' ? self : this, function (Format) {
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

  // Dot positions in byte order (shared with the generator)
  const dataGrid = () => Format.grid();

  function refAnchor(name) {
    const a = (ANCHOR_ANGLE[name] * Math.PI) / 180;
    return { x: SIZE / 2 + ANCHOR_CENTROID_R * Math.cos(a), y: SIZE / 2 + ANCHOR_CENTROID_R * Math.sin(a) };
  }

  // --- 1. Anchor detection (adapts to exposure and camera colour shifts) ---

  // Phone cameras shift the arc colours (red can look orange, blue can look cyan),
  // so the hue bands are wide and overlap; the shape check below sorts them out.
  const BANDS = {
    red: (h) => h >= 330 || h < 40,
    yellow: (h) => h >= 30 && h < 80,
    green: (h) => h >= 80 && h < 172,
    blue: (h) => h >= 172 && h < 262,
  };

  function hueOf(r, g, b, floor) {
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (max < floor) return -1;
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const delta = max - min;
    if (delta < 22) return -1;
    // A reflection adds white on top of a colour: the colour difference survives but
    // the colour looks pale. Accept pale colours when they are clearly lifted by light.
    if (delta < max * 0.34 && !(delta >= 34 && min >= 95)) return -1;
    let h;
    if (max === r) h = (g - b) / delta;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }

  // A few dense blobs of one colour, biggest first
  function blobs(p, cell, maxBlobs, cap) {
    const out = [];
    const used = new Uint8Array(p.length / 2);
    for (let b = 0; b < maxBlobs; b++) {
      const grid = new Map();
      let best = null, bestN = 0;
      for (let k = 0; k < p.length; k += 2) {
        if (used[k / 2]) continue;
        const key = Math.floor(p[k] / cell) + ',' + Math.floor(p[k + 1] / cell);
        const v = (grid.get(key) || 0) + 1;
        grid.set(key, v);
        if (v > bestN) { bestN = v; best = key; }
      }
      if (bestN < 3) break;
      const [gx, gy] = best.split(',').map(Number);
      let cx = (gx + 0.5) * cell, cy = (gy + 0.5) * cell;
      let radius = cell * 3.5, fn = 0;
      for (let iter = 0; iter < 4; iter++) {
        let sx = 0, sy = 0, s2 = 0;
        fn = 0;
        for (let k = 0; k < p.length; k += 2) {
          if (used[k / 2]) continue;
          const dx = p[k] - cx, dy = p[k + 1] - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 <= radius * radius) { sx += p[k]; sy += p[k + 1]; s2 += d2; fn++; }
        }
        if (fn < 5) break;
        cx = sx / fn; cy = sy / fn;
        radius = Math.min(cell * cap, Math.max(cell, 2.6 * Math.sqrt(s2 / fn)));
      }
      // Claim this blob's pixels so the next pass finds a different one
      for (let k = 0; k < p.length; k += 2) {
        const dx = p[k] - cx, dy = p[k + 1] - cy;
        if (dx * dx + dy * dy <= radius * radius * 1.4) used[k / 2] = 1;
      }
      if (fn >= 5) out.push({ x: cx, y: cy, count: fn });
    }
    return out;
  }

  function candidates(img) {
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
        const hue = hueOf(data[i], data[i + 1], data[i + 2], floor);
        if (hue < 0) continue;
        for (const name of NAMES) if (BANDS[name](hue)) pts[name].push(x, y);
      }
    }
    const cell = Math.max(4, minDim / 28);
    const out = {};
    for (const name of NAMES) {
      if (pts[name].length < 12) { out[name] = []; continue; }
      // Whole blobs suit a clean view; size-capped ones keep an arc apart from
      // other coloured things beside it (rings on a web page, lights)
      const list = blobs(pts[name], cell, 3, Infinity);
      for (const q of blobs(pts[name], cell, 6, 5)) {
        if (list.every((o) => Math.hypot(o.x - q.x, o.y - q.y) > cell * 0.5)) list.push(q);
      }
      out[name] = list;
    }
    return { cands: out, pts, minDim };
  }

  // How well do these blobs sit where a Qode's anchors would? Fits rotation + scale
  // (no mirroring) to the reference layout; the leftover error says how Qode-like it is.
  function fitError(set) {
    const ns = NAMES.filter((n) => set[n]);
    let rx = 0, ry = 0, ix = 0, iy = 0;
    for (const n of ns) { const r = refAnchor(n); rx += r.x; ry += r.y; ix += set[n].x; iy += set[n].y; }
    rx /= ns.length; ry /= ns.length; ix /= ns.length; iy /= ns.length;
    let re = 0, im = 0, den = 0;
    for (const n of ns) {
      const r = refAnchor(n), wx = r.x - rx, wy = r.y - ry, zx = set[n].x - ix, zy = set[n].y - iy;
      re += wx * zx + wy * zy; im += wx * zy - wy * zx; den += wx * wx + wy * wy;
    }
    const a = re / den, b = im / den, scale = Math.hypot(a, b);
    let err = 0;
    for (const n of ns) {
      const r = refAnchor(n), wx = r.x - rx, wy = r.y - ry;
      const px = ix + a * wx - b * wy, py = iy + b * wx + a * wy;
      err += (px - set[n].x) ** 2 + (py - set[n].y) ** 2;
    }
    const spread = scale * ANCHOR_CENTROID_R;
    return { err: Math.sqrt(err / ns.length) / Math.max(1e-6, spread), size: spread };
  }

  // --- Line patterns: red solid, blue dotted, green dashed, yellow double ---
  // Colours shift on camera and other coloured things can sit near the code, but
  // the patterns survive. Reads the arc's colourfulness along and across the line.
  const ARC_START = { red: 200, blue: 290, green: 20, yellow: 110 };
  const ARC_LEN = ANCHOR_RADIUS * 2 * ARC_HALF; // ~196 layout units
  const ALONG = 96, ACROSS = [-9, -7.5, -6, -4.5, -3.5, -2, 0, 2, 3.5, 4.5, 6, 7.5, 9];

  function arcPattern(img, map, name) {
    const { data, width: w, height: h } = img;
    const chroma = (p) => {
      const x = Math.round(p.x), y = Math.round(p.y);
      if (x < 0 || y < 0 || x >= w || y >= h) return 0;
      const i = (y * w + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    const a0 = (ARC_START[name] * Math.PI) / 180, span = 2 * ARC_HALF;
    // Pixels per layout unit here (patterns blur out when the code is small)
    const pA = map(SIZE / 2 + ANCHOR_RADIUS * Math.cos(a0), SIZE / 2 + ANCHOR_RADIUS * Math.sin(a0));
    const pB = map(SIZE / 2 + ANCHOR_RADIUS * Math.cos(a0 + span), SIZE / 2 + ANCHOR_RADIUS * Math.sin(a0 + span));
    const scale = Math.hypot(pA.x - pB.x, pA.y - pB.y) / (2 * ANCHOR_RADIUS * Math.sin(ARC_HALF));
    const along = new Float64Array(ALONG), across = new Float64Array(ACROSS.length);
    for (let k = 0; k < ALONG; k++) {
      const a = a0 + ((k + 0.5) / ALONG) * span, ca = Math.cos(a), sa = Math.sin(a);
      let best = 0;
      ACROSS.forEach((d, j) => {
        const v = chroma(map(SIZE / 2 + (ANCHOR_RADIUS + d) * ca, SIZE / 2 + (ANCHOR_RADIUS + d) * sa));
        across[j] += v;
        if (Math.abs(d) <= 4.5 && v > best) best = v;
      });
      along[k] = best;
    }
    let mean = 0;
    for (const v of along) mean += v;
    mean /= ALONG;
    const wave = (period) => {
      let re = 0, im = 0;
      for (let k = 0; k < ALONG; k++) {
        const t = (((k + 0.5) / ALONG) * ARC_LEN * 2 * Math.PI) / period;
        re += (along[k] - mean) * Math.cos(t); im += (along[k] - mean) * Math.sin(t);
      }
      return mean > 0 ? (2 * Math.hypot(re, im)) / (ALONG * mean) : 0;
    };
    const c = ACROSS.indexOf(0), lo = ACROSS.indexOf(-3.5), hi = ACROSS.indexOf(3.5);
    const edge = (across[0] + across[ACROSS.length - 1]) / 2;
    const peak = Math.max(across[lo], across[hi]) - edge;
    return {
      scale, strength: mean,
      p15: wave(15), p30: wave(30),
      dip: peak > 0 ? Math.max(0, Math.min(1.5, (across[c] - edge) / peak)) : 1,
    };
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  // 0..1: how much the line where this anchor should be looks like its own pattern
  function patternMatch(name, o) {
    if (name === 'blue') return clamp01((o.p15 - 0.08) / 0.17);
    if (name === 'green') return clamp01((o.p30 - 0.08) / 0.14);
    if (name === 'yellow') return clamp01((0.9 - o.dip) / 0.5);
    return clamp01(1 - Math.max(o.p15, o.p30) / 0.12) * clamp01((o.dip - 0.75) / 0.2) * 0.6;
  }

  function patternScore(img, set) {
    const m = mappings(set)[0];
    if (!m) return 0;
    let s = 0;
    for (const name of NAMES) s += patternMatch(name, arcPattern(img, m.map, name));
    return s / 4;
  }

  // Read the image along where one arc should be (any colour: cameras shift them)
  // and return the centre of what is there plus how much of the arc is present.
  function snapArc(img, map, name, tol) {
    const { data, width: w, height: h } = img;
    const pad = (8 * Math.PI) / 180;
    const a0 = (ARC_START[name] * Math.PI) / 180, span = 2 * ARC_HALF;
    const STEPS = 40, rstep = Math.max(1, tol / 8);
    const xs = [], ys = [], vs = [], step = [];
    for (let k = 0; k < STEPS; k++) {
      const a = a0 - pad + ((k + 0.5) / STEPS) * (span + 2 * pad), ca = Math.cos(a), sa = Math.sin(a);
      for (let d = -tol; d <= tol + 1e-9; d += rstep) {
        const p = map(SIZE / 2 + (ANCHOR_RADIUS + d) * ca, SIZE / 2 + (ANCHOR_RADIUS + d) * sa);
        const x = Math.round(p.x), y = Math.round(p.y);
        let v = 0;
        if (x >= 0 && y >= 0 && x < w && y < h) {
          const i = (y * w + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
          v = Math.max(r, g, b) - Math.min(r, g, b);
        }
        xs.push(p.x); ys.push(p.y); vs.push(v); step.push(k);
      }
    }
    // Background colourfulness is what most of the window shows
    const sorted = Float64Array.from(vs).sort();
    const base = sorted[Math.floor(sorted.length * 0.5)] + 8;
    let top = 0;
    for (const v of vs) if (v - base > top) top = v - base;
    if (top < 10) return null;
    const best = new Float64Array(STEPS);
    let sx = 0, sy = 0, sw = 0;
    for (let i = 0; i < vs.length; i++) {
      const wgt = vs[i] - base;
      if (wgt <= 0) continue;
      sx += wgt * xs[i]; sy += wgt * ys[i]; sw += wgt;
      if (wgt > best[step[i]]) best[step[i]] = wgt;
    }
    // Coverage over the arc itself (not the padding)
    let inside = 0, covered = 0;
    for (let k = 0; k < STEPS; k++) {
      const a = -pad + ((k + 0.5) / STEPS) * (span + 2 * pad);
      if (a < 0 || a > span) continue;
      inside++;
      if (best[k] > top * 0.3) covered++;
    }
    return { x: sx / sw, y: sy / sw, count: Math.round(sw / 10), coverage: covered / inside };
  }

  // Starting from some trusted anchors, predict every arc, snap each anchor onto what
  // the image shows there, and repeat with a narrower window. A blob that picked up
  // something nearby (a ring on the page, a light) gets pulled back onto its arc,
  // and a missing anchor gets filled in.
  // Position, size and rotation from just two anchors
  function pairMap(ns, cur) {
    const r0 = refAnchor(ns[0]), r1 = refAnchor(ns[1]), p0 = cur[ns[0]], p1 = cur[ns[1]];
    const wx = r1.x - r0.x, wy = r1.y - r0.y, zx = p1.x - p0.x, zy = p1.y - p0.y;
    const den = wx * wx + wy * wy;
    const a = (wx * zx + wy * zy) / den, b = (wx * zy - wy * zx) / den;
    return (x, y) => ({ x: p0.x + a * (x - r0.x) - b * (y - r0.y), y: p0.y + b * (x - r0.x) + a * (y - r0.y) });
  }

  function settle(img, base) {
    let cur = base, cover = {};
    for (const tol of [30, 16, 10]) {
      const ns = NAMES.filter((n) => cur[n]);
      const map = ns.length === 4
        ? homography(ns.map(refAnchor), ns.map((n) => cur[n]))
        : ns.length === 3 ? affine(ns.map(refAnchor), ns.map((n) => cur[n]))
        : ns.length === 2 ? pairMap(ns, cur) : null;
      if (!map) break;
      const next = {};
      cover = {};
      for (const name of NAMES) {
        const s = snapArc(img, map, name, tol);
        if (s && s.coverage >= 0.3) { next[name] = { x: s.x, y: s.y, count: s.count }; cover[name] = s.coverage; }
        else if (cur[name]) next[name] = cur[name];
      }
      cur = next;
    }
    let total = 0;
    for (const name of NAMES) total += cover[name] || 0;
    return { set: cur, coverage: total / 4 };
  }

  // Ranked anchor sets: one blob per colour that together form a Qode's shape
  function anchorSets(img) {
    const { cands, minDim } = candidates(img);
    const opts = NAMES.map((n) => [null, ...cands[n]]);
    const sets = [];
    for (const r of opts[0]) for (const b of opts[1]) for (const g of opts[2]) for (const y of opts[3]) {
      const set = {};
      if (r) set.red = r;
      if (b) set.blue = b;
      if (g) set.green = g;
      if (y) set.yellow = y;
      const vals = Object.values(set);
      const k = vals.length;
      if (k < 3) continue;
      // The same blob cannot be two anchors (the hue bands overlap)
      let clash = false;
      for (let i = 0; i < k && !clash; i++) for (let j = i + 1; j < k; j++) {
        if (Math.hypot(vals[i].x - vals[j].x, vals[i].y - vals[j].y) < minDim * 0.02) { clash = true; break; }
      }
      if (clash) continue;
      const f = fitError(set);
      if (f.size < minDim * 0.035 || f.size > minDim * 1.2) continue;
      // Tilted codes leave some error; anything beyond this is not a Qode
      if (f.err > (k === 4 ? 0.3 : 0.16)) continue;
      sets.push({ set, score: f.err + (4 - k) * 0.12 });
    }
    sets.sort((p, q) => p.score - q.score);
    // The hue bands overlap, so a set can be the right blobs under the wrong names
    // (the code read turned by 90°). Same shape, but the line patterns give it away.
    for (const s of sets.slice(0, 8)) s.score -= patternScore(img, s.set) * 0.8;
    sets.sort((p, q) => p.score - q.score);
    if (sets.length) {
      // Settle the best few, each also from every three of its anchors
      // (so one bad blob cannot spoil the rest), and keep what fits the image best
      const refined = [];
      const seen = new Map();
      const key = (b) => NAMES.map((n) => (b[n] ? Math.round(b[n].x) + ',' + Math.round(b[n].y) : '-')).join('|');
      search: for (const s of sets.slice(0, 6)) {
        const ns = NAMES.filter((n) => s.set[n]);
        const bases = [s.set];
        const pick = (keep) => Object.fromEntries(keep.map((n) => [n, s.set[n]]));
        if (ns.length === 4) for (const skip of ns) bases.push(pick(ns.filter((n) => n !== skip)));
        for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) bases.push(pick([ns[i], ns[j]]));
        for (const base of bases) {
          // Different sets often share blobs: settle each starting point once
          const kb = key(base);
          if (seen.has(kb)) continue;
          seen.set(kb, true);
          const c = settle(img, base);
          const k = Object.keys(c.set).length;
          if (k < 3) continue;
          const pattern = patternScore(img, c.set);
          refined.push({ set: c.set, coverage: c.coverage, pattern, err: fitError(c.set).err, score: fitError(c.set).err + (4 - k) * 0.12 + (1 - c.coverage) * 0.6 - pattern * 0.8 });
          // All four arcs there with their own patterns: no need to look further
          if (k === 4 && c.coverage >= 0.85 && pattern >= 0.55) break search;
        }
      }
      if (!refined.length) return sets.slice(0, 3).map((s) => s.set);
      refined.sort((p, q) => p.score - q.score);
      // Best settled sets first, the blob sets as found after them (settling can
      // also drift on a very blurry code); decode tries them in this order
      const out = [];
      const add = (set) => { if (set && !out.includes(set) && out.length < 4) out.push(set); };
      add(sets[0].set); add(refined[0] && refined[0].set); add(sets[1] && sets[1].set); add(refined[1] && refined[1].set);
      // The settled set sits on the arcs themselves: best for drawing the outline
      out.display = refined[0] ? refined[0].set : sets[0].set;
      out.quality = refined[0] ? { coverage: refined[0].coverage, pattern: refined[0].pattern, err: refined[0].err } : null;
      return out;
    }
    // No full shape: report the strongest colours (for "fit the whole code" hints)
    const partial = {};
    NAMES.map((n) => [n, cands[n][0]]).filter(([, c]) => c)
      .sort((p, q) => q[1].count - p[1].count).slice(0, 2)
      .forEach(([n, c]) => { partial[n] = c; });
    return [partial];
  }

  function findAnchors(img) {
    return anchorSets(img)[0];
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
      // The gap around a dot is dark on a real code; a blown-out gap means a reflection
      let peak = 0;
      for (const o of GAP) { const v = at(p, o); g += v; if (v > peak) peak = v; }
      for (const o of DISC) { e += o[2] * at(p, o); ew += o[2]; }
      feats[i] = { c, r: r / RING.length, e: e / ew, bg: g / GAP.length, peak };
    }
    return feats;
  }

  // Dots within a few steps of each dot (layout space), for a local background
  let nearCache = null;
  function neighbours() {
    if (nearCache) return nearCache;
    const grid = dataGrid(), R = STEP * 2.6;
    nearCache = grid.map((p) => {
      const out = [];
      grid.forEach((q, j) => { if (Math.abs(q.x - p.x) <= R && Math.abs(q.y - p.y) <= R && Math.hypot(q.x - p.x, q.y - p.y) <= R) out.push(j); });
      return out;
    });
    return nearCache;
  }

  // Learn empty / ring / filled from this image itself. Main measure: a dot's total
  // light (blur cannot change it: empty ~0, ring ~half, filled = full). Second
  // measure: brightness right at the centre (rings are dark there when sharp).
  function classify(feats) {
    const n = normalise(feats);
    return n && cluster(n);
  }

  // One photo's dots as two numbers each (total light, centre), scaled to this photo's
  // own white and background, plus which dots sit under a reflection
  function normalise(feats) {
    // Background: blur lets a dot's own light spill into the gap right beside it, so
    // never trust a dot's surroundings to be darker than the code's typical background
    // Reflections brighten a patch of the code: judge each dot against the background
    // around it (the darker gaps nearby, so a neighbour's spilled light does not count)
    const near = neighbours();
    const localBg = feats.map((_, i) => {
      const v = near[i].map((j) => feats[j].bg).sort((a, b) => a - b);
      return v[Math.floor(v.length * 0.3)];
    });
    const bgOf = (f, i) => Math.min(f.bg, localBg[i] + 0.25 * Math.max(0, f.bg - localBg[i]));
    // Dots inside a blown-out reflection carry no information: leave them out
    const bgs = [...localBg].sort((a, b) => a - b);
    const bgTypical = bgs[Math.floor(bgs.length / 2)];
    const glareAt = bgTypical + Math.max(40, (250 - bgTypical) * 0.45);
    const unsure = feats.map((f, i) => localBg[i] > glareAt || f.peak >= 252);
    // White levels: typical of the brightest few dots (a short code may fill only ~1%)
    const topLevel = (vals) => {
      const s = vals.map((v) => Math.max(0, v)).sort((a, b) => b - a);
      const t = s.slice(0, Math.max(3, Math.ceil(s.length * 0.01)));
      return t[Math.floor(t.length / 2)] || 0;
    };
    const eRaw = feats.map((f, i) => f.e - bgOf(f, i));
    const cRaw = feats.map((f, i) => f.c - bgOf(f, i));
    const sure = (vals) => vals.filter((_, i) => !unsure[i]);
    if (sure(eRaw).length < eRaw.length * 0.4) return null; // most of the code is washed out
    const whiteE = topLevel(sure(eRaw)), whiteC = topLevel(sure(cRaw));
    if (whiteE < 6 || whiteC < 12) return null; // no contrast: not a Qode, or far too dark
    const x = eRaw.map((v) => v / whiteE); // total light
    const y = cRaw.map((v) => v / whiteC); // centre
    return { x, y, unsure };
  }

  // Several photos of the same code: a reflection sits somewhere else in each one, so
  // every dot is taken from the photos where it is clear (the middle value of those)
  function combine(list) {
    const n = list[0].x.length, x = new Array(n), y = new Array(n), unsure = new Array(n);
    const mid = (v) => { v.sort((a, b) => a - b); const k = v.length >> 1; return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2; };
    for (let i = 0; i < n; i++) {
      let use = list.filter((d) => !d.unsure[i]);
      unsure[i] = !use.length;
      if (!use.length) use = list;
      x[i] = mid(use.map((d) => d.x[i])); y[i] = mid(use.map((d) => d.y[i]));
    }
    return { x, y, unsure };
  }

  // Two groups: filled and empty. Returns a bit per dot, plus how doubtful each one is.
  function cluster({ x, y, unsure }) {
    // Total light carries the most; the centre helps when the code is a little soft
    const v = x.map((xi, i) => xi + 0.3 * y[i]);
    const sure = v.filter((_, i) => !unsure[i]).sort((a, b) => a - b);
    if (sure.length < 50) return null;
    let m0 = sure[Math.floor(sure.length * 0.2)], m1 = sure[Math.floor(sure.length * 0.9)];
    for (let it = 0; it < 10; it++) {
      const t = (m0 + m1) / 2;
      let s0 = 0, n0 = 0, s1 = 0, n1 = 0;
      for (const val of sure) { if (val > t) { s1 += val; n1++; } else { s0 += val; n0++; } }
      if (!n0 || !n1) return null;
      m0 = s0 / n0; m1 = s1 / n1;
    }
    if (m1 - m0 < 0.3) return null; // no clear filled dots: not a Qode, or far too soft
    const t = (m0 + m1) / 2, half = (m1 - m0) / 2;
    const bits = new Uint8Array(v.length), doubt = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) {
      bits[i] = v[i] > t ? 1 : 0;
      doubt[i] = Math.max(0, 1 - Math.abs(v[i] - t) / half);
    }
    return { bits, doubt, unsure };
  }

  // --- 4. Text and checks ---

  // Reed-Solomon leaves this many parity bytes unused when the read is trustworthy
  const NEED = { 1: 4, 2: 4, 3: 4 };

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
    const sets = anchorSets(img);
    const anchors = sets[0];
    const foundCount = Object.keys(anchors).length;
    const maps = foundCount >= 2 ? mappings(anchors) : [];
    if (!maps.length) return { found: false, foundCount, anchors };
    // Coloured things in a room (a lit keyboard, a bottle, a pen) can fall into a
    // Qode-like shape; a real code's arcs are actually there along their whole length
    if (sets.quality && sets.quality.coverage < 0.6) return { found: false, foundCount: 0, anchors: {} };
    const shown = (sets.display && mappings(sets.display)[0]) || maps[0];
    const g = geometry(shown.map);
    // Runner-up anchor sets, tried by decode when the best one does not read
    const others = sets.slice(1).map((s) => ({ anchors: s, foundCount: Object.keys(s).length, maps: mappings(s) }));
    return { found: true, foundCount, anchors, maps, others, quality: sets.quality, center: g.center, diameter: g.diameter, outline: outlineOf(shown.map) };
  }

  // Read text from dot measurements
  function readFeats(feats, opts, kind) {
    return readDots(classify(feats), opts, kind);
  }
  function readDots(dots, opts, kind) {
    if (!dots) return null;
    const r = Format.decodeBits(dots.bits, dots.unsure, dots.doubt);
    if (!r) return null;
    const strictness = opts.strictness ?? 1;
    if (r.spare < NEED[r.level] * strictness) return null;
    const bonus = kind === 'perspective' ? 0.1 : 0;
    return { text: r.text, ended: true, ecc: r.level, minMargin: r.spare, score: r.spare + bonus, kind };
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
        mapsAgree: best.maps || 1,
        firstChoice: best.firstChoice !== false,
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

    let best = null, bestMap = null, bestLoc = loc;
    const cands = [loc, ...(loc.others || [])];
    const single = (opts.strictness ?? 1) >= 1; // live scanning reads looser and confirms across frames
    for (let ci = 0; ci < cands.length; ci++) {
      const cand = cands[ci];
      // Second-choice anchor sets must read more clearly (fewer chances for a wrong text)
      const o = ci === 0 ? opts : { ...opts, strictness: (opts.strictness ?? 1) * 2.5 };
      let pick = null, persp = null;
      const votes = new Map();
      for (const m of cand.maps) {
        const r = readFeats(measure(img, m.map), o, m.kind);
        if (!r) continue;
        votes.set(r.text, (votes.get(r.text) || 0) + 1);
        if (m.kind === 'perspective') persp = { r, map: m.map };
        if (!pick || r.score > pick.r.score) pick = { r, map: m.map };
        if (m.kind === 'perspective' && r.minMargin >= NEED[r.ecc] * 3) break; // clear enough, skip weaker mappings
      }
      // Mappings that read different texts: trust the full perspective one
      if (pick && votes.size > 1) pick = persp;
      // A single image (an upload) has no second frame to confirm it, so a text read
      // only by a partial mapping of a second-choice set needs another mapping to agree
      if (single && ci > 0 && pick && pick !== persp && votes.get(pick.r.text) < 2) pick = null;
      if (pick) { best = { ...pick.r, maps: votes.get(pick.r.text), firstChoice: ci === 0 }; bestMap = pick.map; bestLoc = cand; break; }
    }
    if (!best) return failure(loc.foundCount < 4 ? 'Need all anchors in view' : 'Could not read the dots yet', loc);
    return success(best, { ...loc, anchors: bestLoc.anchors, foundCount: bestLoc.foundCount }, bestMap);
  }

  // A burst of photos taken while the code was in view (live scanning captures a few
  // as soon as the code is spotted, then reads them at leisure). Each photo is mapped on
  // its own; the dots are combined so reflections and blur in one photo do not matter.
  function decodeMany(imgs, opts = {}) {
    let firstLoc = null;
    const per = [];
    for (const img of imgs) {
      const loc = locate(img);
      if (!loc.found || loc.diameter < (opts.minDiameter || 120)) continue;
      if (!firstLoc) firstLoc = loc;
      // Each photo: its most precise mapping that gives usable dots
      for (const m of loc.maps) {
        const n = normalise(measure(img, m.map));
        if (n) { per.push({ n, loc, map: m.map, kind: m.kind }); break; }
      }
    }
    if (!per.length) return failure('No Qode anchors found', firstLoc || { foundCount: 0, anchors: {} });
    // Every single photo, then all of them together
    const tries = per.map((p) => ({ dots: cluster(p.n), p }));
    if (per.length > 1) tries.push({ dots: cluster(combine(per.map((p) => p.n))), p: per[0], all: true });
    // The photos confirm each other: a text counts when two readings agree (single photos
    // or the combined one), or when one reading is very clear on its own
    const base = Math.max(0.75, opts.strictness ?? 1);
    const reads = [];
    for (const t of tries) {
      const r = readDots(t.dots, { ...opts, strictness: base }, t.p.kind);
      if (r) reads.push({ r, t });
    }
    let best = null;
    for (const x of reads) {
      const agree = reads.filter((o) => o.r.text === x.r.text).length;
      const clear = x.r.minMargin >= NEED[x.r.ecc] * (x.t.all ? 2 : 3);
      if ((per.length === 1 ? x.r.minMargin >= NEED[x.r.ecc] : agree >= 2 || clear) && (!best || x.r.score > best.r.score)) best = { ...x, agree };
    }
    if (!best) return failure('Could not read the dots yet', firstLoc);
    return success({ ...best.r, maps: best.agree }, best.t.p.loc, best.t.p.map);
  }

  return { decode, decodeMany, locate, findAnchors, _internals: { mappings, measure, classify, dataGrid } };
});
