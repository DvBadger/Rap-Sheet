'use strict';
// Links an incident mark (the moment you pressed the hotkey) to a saved replay clip.
//
// A replay file's modified time is roughly when it was saved, so the clip covers
// [endMs - duration, endMs]. You press the key AFTER seeing something, so the event you care about
// is shortly before the mark: we point at the last ~30 seconds up to the mark.

const WINDOW_BEFORE_MARK_SEC = 30;

function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/**
 * @param {{t:number}} mark          mark.t = epoch ms when the hotkey was pressed
 * @param {Array<{file:string,path:string,endMs:number,durationSec:number|null}>} clips
 * @param {{fallbackLenSec?:number, toleranceMs?:number}} opts
 * @returns {null | {file:string,path:string,offsetSec:number,windowStartSec:number,windowEndSec:number,durationKnown:boolean}}
 */
function matchMarkToClip(mark, clips, opts = {}) {
  const fallbackLenSec = opts.fallbackLenSec || 90;
  const toleranceMs = opts.toleranceMs == null ? 8000 : opts.toleranceMs;
  let best = null;
  for (const c of clips) {
    const durationKnown = typeof c.durationSec === 'number' && c.durationSec > 0;
    const durSec = durationKnown ? c.durationSec : fallbackLenSec;
    const startMs = c.endMs - durSec * 1000;
    if (mark.t < startMs - toleranceMs || mark.t > c.endMs + toleranceMs) continue;
    const distance = Math.abs(c.endMs - mark.t);
    if (!best || distance < best.distance) best = { c, startMs, durSec, durationKnown, distance };
  }
  if (!best) return null;
  const offsetSec = Math.min(best.durSec, Math.max(0, (mark.t - best.startMs) / 1000));
  return {
    file: best.c.file,
    path: best.c.path,
    offsetSec,
    windowStartSec: Math.max(0, offsetSec - WINDOW_BEFORE_MARK_SEC),
    windowEndSec: offsetSec,
    durationKnown: best.durationKnown
  };
}

module.exports = { matchMarkToClip, fmtClock, WINDOW_BEFORE_MARK_SEC };
