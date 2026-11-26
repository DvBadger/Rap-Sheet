const path = require('path');
const { createWorker } = require('tesseract.js');
(async () => {
  const langPath = path.join(__dirname, '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int');
  const worker = await createWorker('eng', 1, { langPath, gzip: true, cacheMethod: 'none' });
  const { data } = await worker.recognize(path.join(__dirname, 'fixtures', 'killfeed.png'), {}, { blocks: true });
  const words = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) words.push([w.text, Math.round(w.confidence), l.text.trim().slice(0,30)]);
  console.log('overall confidence', data.confidence, 'blocks', (data.blocks||[]).length, 'words', words.length);
  console.log(words.slice(0, 12));
  await worker.terminate();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
