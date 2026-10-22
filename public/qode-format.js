/*
 * The Qode data format, shared by the generator (qrCode.js) and the decoder.
 *
 * Dots are binary: filled = 1, empty = 0. The text (UTF-8) is stored as bytes with a
 * length byte in front, protected by Reed-Solomon parity (like a QR code), and mixed
 * with a fixed pattern so every part of the code has a mix of filled and empty dots.
 * Each byte's 8 dots sit next to each other (a small 4x2 patch), so a reflection or
 * smudge only costs the few bytes it covers, and error correction restores them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./qode-rs'));
  else root.QodeFormat = factory(root.QodeRS);
})(typeof self !== 'undefined' ? self : this, function (RS) {
  'use strict';

  const SIZE = 500, STEP = 12, RADIUS = SIZE * 0.4;
  // Parity bytes per strength: more parity = more of the code can be hidden or misread
  const LEVELS = { 1: 24, 2: 44, 3: 64 };

  // Dot centres, in byte order: rows are taken two at a time and read left to right,
  // so 8 consecutive dots form a compact 4x2 patch
  let gridCache = null;
  function grid() {
    if (gridCache) return gridCache;
    const c = SIZE / 2, rowHeight = STEP * 0.866, pts = [];
    let row = 0;
    for (let y = 0; y < SIZE; y += rowHeight) {
      const off = row % 2 === 0 ? 0 : STEP / 2;
      for (let x = -STEP; x < SIZE + STEP; x += STEP) {
        const ax = x + off;
        if (Math.hypot(ax - c, y - c) < RADIUS) pts.push({ x: ax, y, row });
      }
      row++;
    }
    pts.sort((a, b) => (a.row >> 1) - (b.row >> 1) || a.x - b.x || a.row - b.row);
    gridCache = pts.map(({ x, y }) => ({ x, y }));
    return gridCache;
  }

  const BYTES = Math.floor(1012 / 8); // checked below against the grid
  const mask = (i) => (i * 151 + 89) & 255; // spreads filled and empty dots evenly

  function capacity(level = 2) { return BYTES - LEVELS[level] - 1; }

  const utf8 = (t) => (typeof TextEncoder !== 'undefined' ? Array.from(new TextEncoder().encode(t)) : Array.from(Buffer.from(t, 'utf8')));

  // text -> one bit per dot (1 = filled)
  function encode(text, level = 2) {
    const nsym = LEVELS[level], k = BYTES - nsym;
    // Too long: drop whole characters from the end until it fits (never half a character)
    let data = utf8(text);
    if (data.length > k - 1) {
      let t = '';
      for (const ch of text) { if (utf8(t + ch).length > k - 1) break; t += ch; }
      data = utf8(t);
    }
    const msg = [data.length, ...data];
    while (msg.length < k) msg.push(0);
    const cw = RS.encode(msg, nsym).map((b, i) => b ^ mask(i));
    const bits = new Uint8Array(grid().length);
    cw.forEach((b, i) => { for (let j = 0; j < 8; j++) bits[i * 8 + j] = (b >> (7 - j)) & 1; });
    return bits;
  }

  // bits: 0/1 per dot; unsure: per dot, true where the dot could not be read (glare).
  // doubt: per dot, how close it was to the other state (0 = certain, 1 = a coin toss).
  // Returns the text and how much error correction was left unused, or null.
  function decodeBits(bits, unsure, doubt) {
    const bytes = [], byteDoubt = [], erased = [];
    for (let i = 0; i < BYTES; i++) {
      let b = 0, d = 0, un = 0;
      for (let j = 0; j < 8; j++) {
        const k = i * 8 + j;
        b = (b << 1) | bits[k];
        if (unsure[k]) un++;
        d = Math.max(d, doubt[k]);
      }
      bytes.push(b ^ mask(i));
      byteDoubt.push(d);
      if (un) erased.push(i);
    }
    // The least certain bytes, most doubtful first, offered as extra erasures if needed
    const order = [...Array(BYTES).keys()].filter((i) => !erased.includes(i)).sort((a, b) => byteDoubt[b] - byteDoubt[a]);
    let best = null;
    for (const level of [3, 2, 1]) {
      const nsym = LEVELS[level];
      for (const extra of [0, 2, 4, 8, 12, 16, 24]) {
        const er = erased.concat(order.slice(0, extra));
        if (er.length > nsym) break;
        const r = RS.correct(bytes, nsym, er);
        if (!r) continue;
        const len = r.data[0];
        if (len > r.data.length - 1) continue;
        // Padding after the text must be zero: a strong check against a wrong level
        let padOk = true;
        for (let i = 1 + len; i < r.data.length; i++) if (r.data[i]) { padOk = false; break; }
        if (!padOk) continue;
        let text;
        try {
          const raw = Uint8Array.from(r.data.slice(1, 1 + len));
          text = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: true }).decode(raw) : Buffer.from(raw).toString('utf8');
        } catch (e) { continue; }
        // Unused correction: what was left after fixing (errors cost two, erasures one)
        const spare = nsym - (r.fixed - r.errors) - 2 * r.errors;
        if (!best || spare > best.spare) best = { text, level, spare, errors: r.errors, erased: r.fixed - r.errors };
        break;
      }
      if (best) break;
    }
    return best;
  }

  if (grid().length < BYTES * 8) throw new Error('Qode grid too small');
  return { SIZE, STEP, LEVELS, BYTES, grid, capacity, encode, decodeBits };
});
