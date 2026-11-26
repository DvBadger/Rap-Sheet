'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mp4DurationSec } = require('../src/lib/mp4');
const { matchMarkToClip, fmtClock } = require('../src/lib/match');
const { normalizeName, similarNames } = require('../src/lib/names');
const { groupReports, historyFor } = require('../src/lib/offenders');
const { extractCandidates, RollingNames } = require('../src/lib/ocrNames');
const { buildReport } = require('../src/lib/report');
const { Store } = require('../src/lib/store');

function box(type, payload) {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(8 + payload.length, 0);
  b.write(type, 4, 'latin1');
  payload.copy(b, 8);
  return b;
}
function mvhdV0(timescale, duration) {
  const p = Buffer.alloc(100);
  p.writeUInt32BE(timescale, 12);
  p.writeUInt32BE(duration, 16);
  return box('mvhd', p);
}
function mvhdV1(timescale, duration) {
  const p = Buffer.alloc(112);
  p.writeUInt8(1, 0);
  p.writeUInt32BE(timescale, 20);
  p.writeBigUInt64BE(BigInt(duration), 24);
  return box('mvhd', p);
}
function tmpFile(name, buf) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-'));
  const f = path.join(d, name);
  fs.writeFileSync(f, buf);
  return f;
}

test('mp4: duration with moov at the end (v0 and v1 mvhd)', () => {
  const ftyp = box('ftyp', Buffer.from('isom0000isom', 'latin1'));
  const mdat = box('mdat', Buffer.alloc(5000, 1));
  const f0 = tmpFile('a.mp4', Buffer.concat([ftyp, mdat, box('moov', mvhdV0(1000, 90500))]));
  assert.equal(mp4DurationSec(f0), 90.5);
  const f1 = tmpFile('b.mp4', Buffer.concat([ftyp, mdat, box('moov', mvhdV1(90000, 90000 * 75))]));
  assert.equal(mp4DurationSec(f1), 75);
});

test('mp4: fragmented / garbage / missing files return null', () => {
  const ftyp = box('ftyp', Buffer.from('isom0000isom', 'latin1'));
  const frag = tmpFile('c.mp4', Buffer.concat([ftyp, box('moov', mvhdV0(1000, 0))]));
  assert.equal(mp4DurationSec(frag), null);
  assert.equal(mp4DurationSec(tmpFile('d.mp4', Buffer.from('not a video'))), null);
  assert.equal(mp4DurationSec(path.join(os.tmpdir(), 'does-not-exist.mp4')), null);
});

test('match: mark inside a clip gets an offset and a 30s look-window', () => {
  const end = 1_700_000_000_000;
  const clips = [{ file: 'Replay A.mp4', path: '/x/Replay A.mp4', endMs: end, durationSec: 90 }];
  const m = matchMarkToClip({ t: end - 1000 }, clips); // key pressed 1s before the file finished
  assert.equal(m.file, 'Replay A.mp4');
  assert.ok(Math.abs(m.offsetSec - 89) < 0.01);
  assert.ok(Math.abs(m.windowStartSec - 59) < 0.01);
  assert.equal(m.durationKnown, true);
});

test('match: picks the nearest clip, ignores clips that do not contain the mark, uses fallback length', () => {
  const t0 = 1_700_000_000_000;
  const clips = [
    { file: 'old.mp4', path: 'p1', endMs: t0 - 600_000, durationSec: 90 },
    { file: 'near.mp4', path: 'p2', endMs: t0 + 2000, durationSec: null },
    { file: 'far.mp4', path: 'p3', endMs: t0 + 40_000, durationSec: 90 }
  ];
  const m = matchMarkToClip({ t: t0 }, clips, { fallbackLenSec: 60 });
  assert.equal(m.file, 'near.mp4');
  assert.equal(m.durationKnown, false);
  assert.equal(matchMarkToClip({ t: t0 - 5_000_000 }, clips), null);
});

test('match: fmtClock', () => {
  assert.equal(fmtClock(72), '1:12');
  assert.equal(fmtClock(5), '0:05');
  assert.equal(fmtClock(3725), '1:02:05');
});

test('names: normalisation folds OCR look-alikes and drops clan tags', () => {
  assert.equal(normalizeName('[SQD] Gh0st77'), normalizeName('ghost77'));
  assert.equal(normalizeName('xX_NightFox_Xx'), 'xxnlghtfoxxx'); // 'i' folds to 'l', as OCR confuses them
  assert.equal(normalizeName('xX_NightFox_Xx'), normalizeName('xX_N1ghtFox_Xx'));
  assert.ok(similarNames('Vortex_99', 'Vortex99'));
  assert.ok(similarNames('BadgerOne', 'BadgerOnc')); // one-char OCR slip
  assert.ok(!similarNames('Bob', 'Rob'));              // short names must match exactly
  assert.ok(!similarNames('NightFox', 'DayWolf'));
});

test('offenders: groups repeats, counts days and servers, history excludes the current report', () => {
  const day = 86_400_000;
  const t = new Date(2026, 10, 20, 18, 0, 0).getTime();
  const reports = [
    { id: 'a', t, player: 'Vortex_99', game: 'WARDOGS', server: 'S1' },
    { id: 'b', t: t + day, player: 'Vortex99', game: 'WARDOGS', server: 'S2' },
    { id: 'c', t: t + 2 * day, player: 'V0rtex_99', game: 'ROB RUN', server: 'S3' },
    { id: 'd', t, player: 'NightFox', game: 'ROB RUN' },
    { id: 'e', t, player: '', game: 'ROB RUN' }
  ];
  const g = groupReports(reports);
  assert.equal(g.length, 2);
  assert.equal(g[0].count, 3);
  assert.equal(g[0].days, 3);
  assert.deepEqual(g[0].games.sort(), ['ROB RUN', 'WARDOGS']);
  assert.equal(g[1].count, 1);
  const h = historyFor('vortex_99', reports, 'c');
  assert.equal(h.count, 2);
  assert.equal(historyFor('SomeoneNew', reports).count, 0);
});

test('ocr names: extraction filters noise, stop words, low confidence, bare clan tags', () => {
  const words = [
    { text: 'xX_NightFox', confidence: 82 }, { text: 'killed', confidence: 93 }, { text: '[SQD]', confidence: 87 },
    { text: 'Ghost77', confidence: 92 }, { text: '12', confidence: 90 }, { text: 'a', confidence: 90 },
    { text: 'Medic', confidence: 34 }, { text: '(Vortex_99)', confidence: 88 }
  ];
  assert.deepEqual(extractCandidates(words, { minConf: 60 }), ['xX_NightFox', 'Ghost77', 'Vortex_99']);
});

test('ocr names: rolling window ranks stable names, merges OCR variants, honours ignore list', () => {
  const r = new RollingNames({ windowMs: 45_000 });
  const t = 1_000_000;
  r.add(t, ['Vortex_99', 'Noise1x']);
  r.add(t + 2000, ['Vortex99', 'MyOwnName']);
  r.add(t + 4000, ['Vortex_99', 'MyOwnName']);
  const top = r.top(t + 5000, { ignore: ['MyOwnName'] });
  assert.equal(top.length, 1);
  assert.equal(top[0].name, 'Vortex_99');
  assert.equal(top[0].frames, 3);
  // frames outside the window drop out
  assert.equal(r.top(t + 200_000).length, 0);
});

test('report: includes clip window, history and fallbacks for missing fields', () => {
  const t = new Date(2026, 10, 23, 18, 42, 10).getTime();
  const txt = buildReport({
    game: 'WARDOGS', t, tz: 'America/Chicago', server: 'EU-3', player: 'Vortex_99',
    behaviors: ['inhuman aim (aimbot / snapping)'], desc: 'Snapped through smoke.',
    clip: { file: 'Replay 18-42-11.mp4', offsetSec: 89, windowStartSec: 59, windowEndSec: 89 },
    history: { count: 2, firstT: t - 86_400_000, lastT: t - 3_600_000, days: 2 }
  });
  assert.match(txt, /CHEATER REPORT - WARDOGS/);
  assert.match(txt, /look between 0:59 and 1:29/);
  assert.match(txt, /Previous reports of this player by me: 2/);
  const bare = buildReport({ game: 'Other' });
  assert.match(bare, /Reported player: \[not provided\]/);
  assert.match(bare, /Clip: \[not attached\]/);
});

test('store: round-trips, merges new default settings into old files, survives corrupt JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-store-'));
  const s = new Store(dir);
  s.load();
  s.updateSettings({ recordingDir: 'C:\\Videos', ocr: { enabled: true } });
  s.data.reports.push({ id: 'r1', player: 'x' });
  s.flush();
  const s2 = new Store(dir);
  s2.load();
  assert.equal(s2.data.settings.recordingDir, 'C:\\Videos');
  assert.equal(s2.data.settings.ocr.enabled, true);
  assert.equal(s2.data.settings.ocr.intervalMs, 2000); // default kept
  assert.equal(s2.data.reports.length, 1);
  fs.writeFileSync(path.join(dir, 'data.json'), '{ broken');
  const s3 = new Store(dir);
  s3.load();
  assert.equal(s3.data.reports.length, 0);
});

// ---- game-window reading area
const { toFractions, fractionRect, pickWindowName } = require('../src/lib/region');
test('region fractions round-trip at any resolution', () => {
  const f = toFractions({ x: 100, y: 50, width: 400, height: 200 }, 1000, 500);
  assert.deepEqual(fractionRect(f, 1000, 500), { x: 100, y: 50, width: 400, height: 200 });
  assert.deepEqual(fractionRect(f, 2000, 1000), { x: 200, y: 100, width: 800, height: 400 });
});
test('region is clamped inside the window and tiny areas are rejected', () => {
  const f = toFractions({ x: 900, y: 450, width: 400, height: 400 }, 1000, 500);
  const r = fractionRect(f, 1000, 500);
  assert.ok(r.x + r.width <= 1000 && r.y + r.height <= 500);
  assert.equal(fractionRect({ rel: true, fx: 0.5, fy: 0.5, fw: 0.001, fh: 0.001 }, 1000, 500), null);
  assert.equal(fractionRect({ x: 1, y: 1, width: 50, height: 50 }, 1000, 500), null); // old whole-screen areas are not used
});
test('window name matching never picks an unrelated window', () => {
  const names = ['Discord', 'Notepad', 'Rob Run - Early Access'];
  assert.equal(pickWindowName('Rob Run - Early Access', names), 'Rob Run - Early Access');
  assert.equal(pickWindowName('rob run', names), 'Rob Run - Early Access');
  assert.equal(pickWindowName('Chrome', names), null);
  assert.equal(pickWindowName('', names), null);
});
