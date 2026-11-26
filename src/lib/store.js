'use strict';
// Tiny JSON store: settings, marks (incidents) and saved reports. Writes are atomic (temp file + rename).
const fs = require('fs');
const path = require('path');

const DEFAULTS = () => ({
  settings: {
    game: 'ROB RUN',
    gameName: '',
    hotkey: { keycode: null, name: '', ctrl: false, alt: false, shift: false, meta: false },
    hotkeyMode: 'safe',
    safeHotkey: 'F5',
    fallbackHotkey: 'Control+Shift+F9',
    recordingDir: '',
    replayLenSec: 90,
    record: { enabled: true, source: 'screen', display: 'auto', quality: '720', encoder: 'auto', dir: '' },
    ocr: { enabled: false, gameWindow: '', regionsByWindow: {}, mode: 'press', maxWatchSec: 120, region: null, intervalMs: 2000, minConf: 60, scale: 2 },
    ignoreNames: [],
    saveScreenshot: true,
    startWithWindows: false,
    minimizeToTray: true,
    firstRunDone: false
  },
  marks: [],
  reports: []
});

function merge(base, extra) {
  if (Array.isArray(base) || base === null || typeof base !== 'object') return extra === undefined ? base : extra;
  const out = { ...base };
  if (extra && typeof extra === 'object') {
    for (const k of Object.keys(extra)) out[k] = merge(base[k], extra[k]);
  }
  return out;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'data.json');
    this.data = DEFAULTS();
    this._timer = null;
  }

  load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const d = DEFAULTS();
      d.settings = merge(d.settings, raw.settings);
      d.marks = Array.isArray(raw.marks) ? raw.marks : [];
      d.reports = Array.isArray(raw.reports) ? raw.reports : [];
      this.data = d;
    } catch (e) {
      this.data = DEFAULTS();
    }
    return this.data;
  }

  saveNow() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) { /* keep running; data stays in memory */ }
  }

  save() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this.saveNow(); }, 300);
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.saveNow();
  }

  updateSettings(partial) {
    this.data.settings = merge(this.data.settings, partial);
    this.save();
    return this.data.settings;
  }
}

module.exports = { Store, DEFAULTS, merge };
