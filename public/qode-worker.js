// Runs the decoder off the main thread so the camera view stays smooth.
//   { type: 'locate' } -> where the code is (fast, used for tracking every frame)
//   { type: 'decode' } -> read the text from a full-resolution frame (thorough)
importScripts('qode-rs.js?v=9', 'qode-format.js?v=9', 'qode-decoder.js?v=9');

self.onmessage = (e) => {
  const { id, type, width, height, buffer, frames, options } = e.data;
  const img = buffer && { data: new Uint8ClampedArray(buffer), width, height };
  const started = performance.now();
  let result;
  try {
    if (type === 'locate') {
      const loc = self.QodeDecoder.locate(img);
      // Mapping functions cannot cross to the page; send only plain values
      result = { found: loc.found, foundCount: loc.foundCount, outline: loc.outline, center: loc.center, diameter: loc.diameter };
    } else if (type === 'decodeMany') {
      const imgs = frames.map((f) => ({ data: new Uint8ClampedArray(f.buffer), width: f.width, height: f.height }));
      result = self.QodeDecoder.decodeMany(imgs, options || {});
    } else {
      result = self.QodeDecoder.decode(img, options || {});
    }
  } catch (err) {
    result = { success: false, found: false, reason: err.message, meta: { foundCount: 0 } };
  }
  result.ms = Math.round(performance.now() - started);
  self.postMessage({ id, type, width, height, result });
};
