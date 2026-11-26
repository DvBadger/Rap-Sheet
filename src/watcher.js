'use strict';
// Watches the recording folder for new replay clips and reports each one once it has stopped growing.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { mp4DurationSec } = require('./lib/mp4');
const { log } = require('./logger');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.flv', '.ts', '.m4v']);
const MP4_LIKE = new Set(['.mp4', '.mov', '.m4v']);
const STABLE_MS = 1500;
const STARTUP_RECENT_MS = 10 * 60 * 1000;
const KEEP_CLIPS = 60;

class ClipWatcher extends EventEmitter {
  constructor() {
    super();
    this.dir = '';
    this.known = new Map();
    this.recent = []; // finished clips, newest first
    this.timer = null;
    this.ok = false;
    this.error = '';
  }

  start(dir) {
    this.stop();
    this.dir = dir || '';
    this.known = new Map();
    this.recent = [];
    this.ok = false;
    this.error = '';
    if (!this.dir) { this.error = 'No recording folder chosen yet.'; return; }
    try {
      if (!fs.statSync(this.dir).isDirectory()) throw new Error('not a folder');
    } catch (e) {
      this.error = 'That folder does not exist.';
      log('watcher: bad folder', this.dir);
      return;
    }
    this.ok = true;
    this._scan(true);
    this.timer = setInterval(() => this._scan(false), 1000);
    log('watcher: watching', this.dir);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _scan(initial) {
    let names;
    try {
      names = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch (e) {
      this.ok = false;
      this.error = 'Cannot read the recording folder.';
      return;
    }
    this.ok = true;
    this.error = '';
    const now = Date.now();
    for (const d of names) {
      if (!d.isFile()) continue;
      const ext = path.extname(d.name).toLowerCase();
      if (!VIDEO_EXT.has(ext)) continue;
      const full = path.join(this.dir, d.name);
      let entry = this.known.get(full);
      if (entry && entry.emitted) continue;
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!entry) {
        const recentAtStart = initial && now - st.mtimeMs < STARTUP_RECENT_MS;
        entry = {
          size: st.size, mtimeMs: st.mtimeMs, changedAt: now,
          emitted: initial && !recentAtStart // old files present at startup are ignored
        };
        this.known.set(full, entry);
        if (entry.emitted) continue;
        if (initial) entry.changedAt = now - STABLE_MS; // already finished, emit right away
      } else if (st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) {
        entry.size = st.size;
        entry.mtimeMs = st.mtimeMs;
        entry.changedAt = now;
        continue;
      }
      if (now - entry.changedAt >= STABLE_MS && st.size > 0) {
        entry.emitted = true;
        const clip = {
          file: d.name,
          path: full,
          endMs: st.mtimeMs,
          durationSec: MP4_LIKE.has(ext) ? mp4DurationSec(full) : null
        };
        this.recent.unshift(clip);
        if (this.recent.length > KEEP_CLIPS) this.recent.pop();
        log('watcher: clip ready', d.name, clip.durationSec == null ? '(duration unknown)' : `${Math.round(clip.durationSec)}s`);
        this.emit('clip', clip);
      }
    }
  }
}

// Picks the most likely recording folder: prefers a candidate that contains a recent "Replay ..." clip.
function detectRecordingDir(candidates) {
  let best = null;
  for (const dir of candidates) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const d of entries) {
      if (!d.isFile() || !VIDEO_EXT.has(path.extname(d.name).toLowerCase())) continue;
      let st;
      try { st = fs.statSync(path.join(dir, d.name)); } catch (e) { continue; }
      const score = st.mtimeMs + (/replay/i.test(d.name) ? 1e12 : 0);
      if (!best || score > best.score) best = { dir, score };
    }
  }
  if (best) return best.dir;
  for (const dir of candidates) {
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch (e) { /* next */ }
  }
  return '';
}

module.exports = { ClipWatcher, detectRecordingDir };
