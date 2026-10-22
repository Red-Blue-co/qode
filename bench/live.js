// Open the real scanner page with a fake camera playing a clip; time how long until it reads
const { chromium } = require('C:/Users/SherinVarghese/Desktop/sv/og/node_modules/playwright');
const path = require('path');
(async () => {
  const clip = path.resolve(process.argv[2]);
  const b = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`] });
  const p = await b.newPage({ viewport: { width: 420, height: 860 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  const t0 = Date.now();
  await p.goto('http://localhost:3077/scanner', { waitUntil: 'load' });
  const statuses = [];
  await p.waitForFunction(() => document.getElementById('video-feed')?.readyState >= 2, null, { timeout: 15000 }).catch(() => {});
  const tv = Date.now() - t0;
  let res = null;
  for (let i = 0; i < 120; i++) {
    await p.waitForTimeout(100);
    const s = await p.evaluate(() => ({ st: document.getElementById('scan-status')?.textContent, r: !document.getElementById('result-box').classList.contains('hidden') && document.getElementById('scan-result').textContent }));
    if (!statuses.length || statuses[statuses.length - 1].st !== s.st) statuses.push({ t: Date.now() - t0, st: s.st });
    if (s.r) { res = { t: Date.now() - t0 }; await p.waitForTimeout(2500); res.text = await p.evaluate(() => document.getElementById('scan-result').textContent); break; }
  }
  console.log(path.basename(clip), 'camera ready at', tv, 'ms |', res ? `READ ${res.t - tv} ms after camera start -> ${res.text}` : 'NOT READ in 12 s after camera start', '| errors', errs.length, errs[0] || '');
  console.log(statuses.map((s) => `${s.t}ms ${s.st}`).join(' | '));
  await p.screenshot({ path: process.argv[3] });
  await b.close();
})();
