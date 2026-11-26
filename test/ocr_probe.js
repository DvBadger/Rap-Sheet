const path = require('path');
const { createWorker } = require('tesseract.js');
(async () => {
  const langPath = path.join(__dirname, '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int');
  const t0 = Date.now();
  const worker = await createWorker('eng', 1, { langPath, gzip: true, cacheMethod: 'none' });
  console.log('worker ready in', Date.now() - t0, 'ms');
  const t1 = Date.now();
  const { data } = await worker.recognize(path.join(__dirname, 'fixtures', 'killfeed.png'));
  console.log('recognize', Date.now() - t1, 'ms');
  console.log(JSON.stringify(data.text));
  console.log('keys', Object.keys(data).join(','));
  console.log('words sample', (data.words || []).slice(0, 4).map(w => [w.text, Math.round(w.confidence)]));
  await worker.terminate();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
