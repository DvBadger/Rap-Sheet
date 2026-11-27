'use strict';
// Turns raw OCR words into "possible player name" candidates, and keeps a rolling window of frames
// so that names which appear repeatedly (not one-off OCR noise) rise to the top.
const { normalizeName, similarKeys } = require('./names');

const STOP = new Set([
  'killed', 'kills', 'kill', 'eliminated', 'headshot', 'assisted', 'assist', 'by', 'with', 'the', 'and',
  'destroyed', 'revived', 'down', 'downed', 'died', 'shot', 'knifed', 'vs', 'you', 'player', 'team',
  'squad', 'score', 'level', 'lvl', 'xp', 'ping', 'fps', 'spotted', 'captured', 'bled', 'out', 'from',
  'was', 'has', 'for', 'his', 'her', 'their', 'ammo', 'health', 'reload',
  // menu, loading-screen and HUD words that are never player names
  'early', 'access', 'does', 'not', 'reflect', 'final', 'quality', 'game', 'knockout', 'surrender', 'report',
  'chat', 'mute', 'block', 'friend', 'friends', 'invite', 'party', 'lobby', 'match', 'round', 'play', 'settings',
  'options', 'quit', 'exit', 'back', 'continue', 'resume', 'start', 'ready', 'waiting', 'loading', 'press',
  'hold', 'victory', 'defeat', 'winner', 'lose', 'rank', 'ranked', 'mode', 'map', 'respawn', 'spectate',
  'objective', 'zone', 'warning', 'danger', 'safe', 'build', 'version', 'server', 'region', 'login', 'online',
  'offline', 'connecting', 'connected', 'select', 'confirm', 'cancel', 'accept', 'decline', 'ready', 'next',
  'previous', 'inventory', 'equip', 'weapon', 'weapons', 'item', 'items', 'shop', 'store', 'buy', 'sell', 'crafting',
  'time', 'remaining', 'left', 'right', 'about', 'are', 'you', 'your', 'this', 'that', 'will', 'can', 'have', 'all',
  'new', 'now', 'out', 'off', 'one', 'two', 'but', 'any', 'get', 'got', 'use', 'used', 'more', 'than', 'then'
]);

function cleanToken(t) {
  return String(t || '').replace(/^[^\w[]+|[^\w\]]+$/g, '');
}

/**
 * @param {Array<{text:string,confidence:number}>} words OCR words
 * @param {{minConf?:number}} opts
 * @returns {string[]} cleaned candidate tokens
 */
function extractCandidates(words, opts = {}) {
  const minConf = opts.minConf == null ? 60 : opts.minConf;
  const out = [];
  for (const w of words || []) {
    if (!w || typeof w.text !== 'string') continue;
    if (typeof w.confidence === 'number' && w.confidence < minConf) continue;
    const tok = cleanToken(w.text);
    if (/^\[.*\]$/.test(tok)) continue; // clan tags on their own
    if (tok.length < 3 || tok.length > 24) continue;
    if (!/[A-Za-z]/.test(tok)) continue;
    if (STOP.has(tok.toLowerCase())) continue;
    out.push(tok);
  }
  return out;
}

class RollingNames {
  constructor(opts = {}) {
    this.windowMs = opts.windowMs || 45000;
    this.frames = []; // {t, tokens:[...]}
  }

  add(t, tokens) {
    this.frames.push({ t, tokens: [...new Set(tokens)] });
    const cutoff = t - this.windowMs;
    while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift();
  }

  clear() { this.frames = []; }

  top(now, opts = {}) {
    const limit = opts.limit || 8;
    const minFrames = opts.minFrames == null ? 2 : opts.minFrames;
    const ignoreKeys = (opts.ignore || []).map(normalizeName).filter(Boolean);
    const clusters = [];
    for (const f of this.frames) {
      if (f.t < now - this.windowMs) continue;
      const seenThisFrame = new Set();
      for (const raw of f.tokens) {
        const key = normalizeName(raw);
        if (!key) continue;
        if (ignoreKeys.some((k) => similarKeys(k, key))) continue;
        let c = clusters.find((x) => similarKeys(x.key, key));
        if (!c) {
          c = { key, spellings: new Map(), frames: 0, last: 0 };
          clusters.push(c);
        }
        c.spellings.set(raw, (c.spellings.get(raw) || 0) + 1);
        if (!seenThisFrame.has(c)) {
          c.frames += 1;
          seenThisFrame.add(c);
        }
        if (f.t > c.last) c.last = f.t;
      }
    }
    return clusters
      .filter((c) => c.frames >= minFrames)
      .map((c) => {
        const sp = [...c.spellings.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
        return { name: sp[0][0], frames: c.frames, lastSeen: c.last };
      })
      .sort((a, b) => b.frames - a.frames || b.lastSeen - a.lastSeen)
      .slice(0, limit);
  }
}

module.exports = { extractCandidates, RollingNames };
