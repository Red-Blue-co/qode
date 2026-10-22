// Scanner bench: real Qodes turned into "camera photos" with glare, blur, tilt and noise.
// Measures how often the decoder reads them correctly, how often it is wrong, and how fast.
//   node bench/bench.js [count]
"use strict";
const { createCanvas, loadImage } = require("canvas");
const HexGenerator = require("../qrCode");
const QodeDecoder = require("../public/qode-decoder");

const N = +(process.argv[2] || 40);
const TEXTS = ["https://qode.sherin.fun", "hello", "Sherin Varghese", "https://sherin.fun/projects", "QODE 2026", "meet me at 7"];

// small deterministic random so runs are comparable
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

async function photo(png, scene) {
  const img = await loadImage(png);
  const W = 1280, H = 720;
  const c = createCanvas(W, H), g = c.getContext("2d");
  // a screen or paper background with a soft vignette
  g.fillStyle = scene.bg; g.fillRect(0, 0, W, H);
  g.save();
  g.translate(W / 2 + scene.dx, H / 2 + scene.dy);
  g.rotate(scene.rot);
  g.transform(1, scene.skewY, scene.skewX, 1 - scene.squash, 0, 0); // tilt (affine stand-in for perspective)
  const s = scene.size;
  g.filter = `blur(${scene.blur}px)`;
  g.drawImage(img, -s / 2, -s / 2, s, s);
  g.restore();
  // lower contrast and colour cast, like a phone camera looking at a screen
  g.globalCompositeOperation = "source-over";
  g.fillStyle = `rgba(${scene.cast.join(",")},${scene.haze})`; g.fillRect(0, 0, W, H);
  // glare: bright soft reflections, sometimes blown out
  g.globalCompositeOperation = "lighter";
  for (const gl of scene.glare) {
    const rg = g.createRadialGradient(gl.x, gl.y, 0, gl.x, gl.y, gl.r);
    rg.addColorStop(0, `rgba(255,255,255,${gl.a})`);
    rg.addColorStop(0.35, `rgba(255,255,255,${gl.a * 0.75})`);
    rg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = rg; g.beginPath(); g.ellipse(gl.x, gl.y, gl.r, gl.r * gl.flat, gl.ang, 0, Math.PI * 2); g.fill();
  }
  g.globalCompositeOperation = "source-over";
  const d = g.getImageData(0, 0, W, H);
  for (let i = 0; i < d.data.length; i += 4) {
    const n = (rnd() - 0.5) * scene.noise;
    d.data[i] += n; d.data[i + 1] += n; d.data[i + 2] += n;
  }
  return d;
}

function makeScene(level) {
  const size = 300 + rnd() * 260;
  const glare = [];
  const nGlare = level === "clean" ? 0 : 1 + Math.floor(rnd() * (level === "hard" ? 3 : 2));
  for (let k = 0; k < nGlare; k++) {
    glare.push({
      x: 640 + (rnd() - 0.5) * size * 0.9, y: 360 + (rnd() - 0.5) * size * 0.9,
      r: size * (0.12 + rnd() * (level === "hard" ? 0.35 : 0.22)), a: level === "hard" ? 0.55 + rnd() * 0.45 : 0.3 + rnd() * 0.4,
      flat: 0.35 + rnd() * 0.65, ang: rnd() * Math.PI,
    });
  }
  return {
    bg: ["#f4f1ea", "#20242b", "#d9d4ca"][Math.floor(rnd() * 3)],
    size, dx: (rnd() - 0.5) * 200, dy: (rnd() - 0.5) * 120, rot: rnd() * Math.PI * 2,
    skewX: (rnd() - 0.5) * 0.25, skewY: (rnd() - 0.5) * 0.25, squash: rnd() * 0.2,
    blur: rnd() * (level === "hard" ? 1.8 : 1.2), noise: 10 + rnd() * 18,
    cast: [Math.floor(rnd() * 255), Math.floor(rnd() * 255), Math.floor(rnd() * 255)], haze: rnd() * 0.12,
    glare,
  };
}

module.exports = { photo, makeScene, photoFor: async (k) => { seed = 777 + k * 31; const png = await new HexGenerator({ eccLevel: 2 }).generateImageBuffer("https://qode.sherin.fun"); return photo(png, makeScene(["glare", "hard", "hard"][k])); } };
if (require.main === module && process.argv[3] !== 'burst') (async () => {
  const levels = ["clean", "glare", "hard"];
  const stats = {};
  for (const level of levels) stats[level] = { ok: 0, wrong: 0, fail: 0, ms: [], reasons: {} };
  seed = 12345;
  for (let i = 0; i < N; i++) {
    const text = TEXTS[i % TEXTS.length], ecc = 1 + (i % 3) === 1 ? 2 : [2, 3, 2][i % 3];
    const png = await new HexGenerator({ eccLevel: ecc }).generateImageBuffer(text);
    for (const level of levels) {
      const img = await photo(png, makeScene(level));
      const t = Date.now();
      // live scanning settings (looser, frames confirm each other)
      const r = QodeDecoder.decode(img, { strictness: 0.75 });
      stats[level].ms.push(Date.now() - t);
      if (r.success && r.payload === text) stats[level].ok++;
      else if (r.success) stats[level].wrong++;
      else { stats[level].fail++; stats[level].reasons[r.reason] = (stats[level].reasons[r.reason] || 0) + 1; }
    }
  }
  for (const level of levels) {
    const s = stats[level], ms = s.ms.sort((a, b) => a - b);
    console.log(`${level.padEnd(6)} read ${String(s.ok).padStart(3)}/${N}  wrong ${s.wrong}  failed ${s.fail}  median ${ms[ms.length >> 1]}ms  p90 ${ms[Math.floor(ms.length * 0.9)]}ms  ${JSON.stringify(s.reasons)}`);
  }
})();

// Burst: 5 photos of one code with the hand shaking a little, so the reflection moves
if (require.main === module && process.argv[3] === 'burst') (async () => {
  const N2 = +(process.argv[2] || 30);
  for (const level of ['glare', 'hard']) {
    seed = 999;
    let single = 0, many = 0, wrong = 0; const ms = []; const reasons = {};
    for (let i = 0; i < N2; i++) {
      const text = TEXTS[i % TEXTS.length], ecc = [2, 3, 2][i % 3];
      const png = await new HexGenerator({ eccLevel: ecc }).generateImageBuffer(text);
      const base = makeScene(level), shots = [];
      for (let k = 0; k < 5; k++) {
        const sc = JSON.parse(JSON.stringify(base));
        sc.dx += (rnd() - 0.5) * 30; sc.dy += (rnd() - 0.5) * 30; sc.rot += (rnd() - 0.5) * 0.08;
        // the light stays, the code moves under it: shift every reflection a little
        sc.glare.forEach((gl) => { gl.x += (rnd() - 0.5) * base.size * 0.35; gl.y += (rnd() - 0.5) * base.size * 0.35; });
        shots.push(await photo(png, sc));
      }
      const r1 = QodeDecoder.decode(shots[0], { strictness: 0.75 });
      if (r1.success && r1.payload === text) single++;
      const t = Date.now();
      const r = QodeDecoder.decodeMany(shots, { strictness: 0.75 });
      ms.push(Date.now() - t);
      if (!r.success) { reasons[r.reason] = (reasons[r.reason] || 0) + 1; }
      if (r.success && r.payload === text) many++; else if (r.success) { wrong++; console.log('WRONG', i, level, JSON.stringify(text), '->', JSON.stringify(r.payload), 'ecc', r.meta.ecc, 'margin', r.meta.margin, 'maps', r.meta.mapsAgree, r.meta.method); }
    }
    ms.sort((a, b) => a - b);
    console.log(`${level.padEnd(6)} one photo ${single}/${N2}   burst of 5 ${many}/${N2}  wrong ${wrong}  burst median ${ms[ms.length >> 1]}ms ${JSON.stringify(reasons)}`);
  }
})();
