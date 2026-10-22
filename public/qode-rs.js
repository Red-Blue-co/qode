/*
 * Reed-Solomon error correction over GF(256), as used by QR codes.
 * Corrects wrong bytes, and twice as many "erased" bytes (bytes we already know
 * are unreadable, like dots under a reflection). Runs in the browser, workers and Node.
 *
 *   QodeRS.encode(bytes, nsym)              -> bytes + nsym parity bytes
 *   QodeRS.correct(codeword, nsym, erasures) -> { data, fixed } or null
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QodeRS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  const div = (a, b) => { if (!b) throw new Error('div by 0'); return a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0; };
  const pow = (a, p) => EXP[(((LOG[a] * p) % 255) + 255) % 255];
  const inv = (a) => EXP[255 - LOG[a]];

  const polyScale = (p, s) => p.map((c) => mul(c, s));
  function polyAdd(p, q) {
    const r = new Array(Math.max(p.length, q.length)).fill(0);
    for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
    for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
    return r;
  }
  function polyMul(p, q) {
    const r = new Array(p.length + q.length - 1).fill(0);
    for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
    return r;
  }
  function polyEval(p, v) {
    let y = p[0];
    for (let i = 1; i < p.length; i++) y = mul(y, v) ^ p[i];
    return y;
  }

  const genCache = {};
  function generator(nsym) {
    if (genCache[nsym]) return genCache[nsym];
    let g = [1];
    for (let i = 0; i < nsym; i++) g = polyMul(g, [1, pow(2, i)]);
    return (genCache[nsym] = g);
  }

  function encode(msg, nsym) {
    const gen = generator(nsym);
    const out = new Array(msg.length + nsym).fill(0);
    for (let i = 0; i < msg.length; i++) out[i] = msg[i];
    for (let i = 0; i < msg.length; i++) {
      const c = out[i];
      if (c) for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], c);
    }
    for (let i = 0; i < msg.length; i++) out[i] = msg[i];
    return out;
  }

  function syndromes(msg, nsym) {
    const s = [0];
    for (let i = 0; i < nsym; i++) s.push(polyEval(msg, pow(2, i)));
    return s;
  }

  function errataLocator(coefPos) {
    let loc = [1];
    for (const i of coefPos) loc = polyMul(loc, polyAdd([1], [pow(2, i), 0]));
    return loc;
  }

  function errorEvaluator(synd, errLoc, nsym) {
    const p = polyMul(synd, errLoc);
    return p.slice(p.length - (nsym + 1));
  }

  function correctErrata(msg, synd, errPos) {
    const coefPos = errPos.map((p) => msg.length - 1 - p);
    const errLoc = errataLocator(coefPos);
    const errEval = errorEvaluator([...synd].reverse(), errLoc, errLoc.length - 1).reverse();
    const X = coefPos.map((c) => pow(2, -(255 - c)));
    const E = new Array(msg.length).fill(0);
    for (let i = 0; i < X.length; i++) {
      const Xi = X[i], XiInv = inv(Xi);
      let prime = 1;
      for (let j = 0; j < X.length; j++) if (j !== i) prime = mul(prime, 1 ^ mul(XiInv, X[j]));
      if (!prime) return null;
      const y = mul(Xi, polyEval([...errEval].reverse(), XiInv));
      E[errPos[i]] = div(y, prime);
    }
    return polyAdd(msg, E);
  }

  function errorLocator(synd, nsym, eraseCount) {
    let errLoc = [1], oldLoc = [1];
    const shift = synd.length > nsym ? synd.length - nsym : 0;
    for (let i = 0; i < nsym - eraseCount; i++) {
      const K = i + shift;
      let delta = synd[K];
      for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - (j + 1)], synd[K - j]);
      oldLoc = oldLoc.concat([0]);
      if (delta) {
        if (oldLoc.length > errLoc.length) {
          const next = polyScale(oldLoc, delta);
          oldLoc = polyScale(errLoc, inv(delta));
          errLoc = next;
        }
        errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
      }
    }
    while (errLoc.length && errLoc[0] === 0) errLoc.shift();
    const errs = errLoc.length - 1;
    if (errs * 2 + eraseCount > nsym) return null;
    return errLoc;
  }

  function findErrors(errLoc, n) {
    const errs = errLoc.length - 1, pos = [];
    for (let i = 0; i < n; i++) if (polyEval(errLoc, pow(2, i)) === 0) pos.push(n - 1 - i);
    return pos.length === errs ? pos : null;
  }

  function forneySyndromes(synd, pos, n) {
    const f = synd.slice(1);
    for (const p of pos) {
      const xv = pow(2, n - 1 - p);
      for (let j = 0; j < f.length - 1; j++) f[j] = mul(f[j], xv) ^ f[j + 1];
    }
    return f;
  }

  // codeword: data + parity; erasures: positions known to be unreadable
  function correct(codeword, nsym, erasures = []) {
    if (erasures.length > nsym) return null;
    let msg = Array.from(codeword);
    for (const p of erasures) msg[p] = 0;
    let synd = syndromes(msg, nsym);
    if (Math.max(...synd) === 0) return { data: msg.slice(0, msg.length - nsym), fixed: erasures.length, errors: 0 };
    const fsynd = forneySyndromes(synd, erasures, msg.length);
    const errLoc = errorLocator(fsynd, nsym, erasures.length);
    if (!errLoc) return null;
    const errPos = findErrors([...errLoc].reverse(), msg.length);
    if (!errPos) return null;
    const fixedMsg = correctErrata(msg, synd, erasures.concat(errPos));
    if (!fixedMsg) return null;
    synd = syndromes(fixedMsg, nsym);
    if (Math.max(...synd) !== 0) return null;
    return { data: fixedMsg.slice(0, fixedMsg.length - nsym), fixed: erasures.length + errPos.length, errors: errPos.length };
  }

  return { encode, correct };
});
