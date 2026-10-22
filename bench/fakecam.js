// Fake phone camera: an MJPEG clip of a Qode with the hand shaking and a moving reflection
const fs = require('fs');
const { createCanvas } = require('canvas');
const b = require('./bench-lib');
const HexGenerator = require('../qrCode');
(async () => {
  const [out, level, text] = [process.argv[2], process.argv[3] || 'glare', process.argv[4] || 'https://qode.sherin.fun'];
  const png = await new HexGenerator({ eccLevel: 2 }).generateImageBuffer(text);
  const base = b.makeScene(level); base.dx = 0; base.dy = 0; base.size = 380;
  const parts = [];
  for (let k = 0; k < 90; k++) {
    const sc = JSON.parse(JSON.stringify(base));
    sc.dx = Math.sin(k / 7) * 14; sc.dy = Math.cos(k / 9) * 10; sc.rot += Math.sin(k / 11) * 0.03;
    sc.glare.forEach((gl, j) => { gl.x += Math.sin(k / 8 + j) * base.size * 0.18; gl.y += Math.cos(k / 10 + j) * base.size * 0.14; });
    const d = await b.photo(png, sc);
    const c = createCanvas(1280, 720); c.getContext('2d').putImageData(d, 0, 0);
    parts.push(c.toBuffer('image/jpeg', { quality: 0.9 }));
  }
  fs.writeFileSync(out, Buffer.concat(parts));
  console.log('frames', parts.length);
})();
