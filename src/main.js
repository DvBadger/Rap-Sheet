'use strict';
const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, dialog, clipboard, Notification, nativeImage, screen, shell, globalShortcut, session, desktopCapturer
} = require('electron');

const logger = require('./logger');
const { log } = logger;
const { Store } = require('./lib/store');
const { matchMarkToClip, fmtClock } = require('./lib/match');
const { groupReports, historyFor } = require('./lib/offenders');
const { buildReport, ROUTES, GAMES } = require('./lib/report');
const { Hotkeys, describe } = require('./hotkeys');
const { ClipWatcher, detectRecordingDir } = require('./watcher');
const { OcrLoop } = require('./ocr');
const capture = require('./capture');
const { toFractions, pickWindowName } = require('./lib/region');

const ICON = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const ICON_PNG = path.join(__dirname, '..', 'assets', 'icon.png');
const LANG_PATH = path.join(__dirname, '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int');
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } })();

let win = null;
let tray = null;
let picker = null;
let quitting = false;
let store;
let hotkeys;
let updater;
let watcher;
let ocr;
let broadcastTimer = null;
let fallbackAcc = '';
let fallbackRegistered = false;
let safeAcc = '';
let safeOk = false;
let safeError = '';
let lastMarkAt = 0;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function publicState() {
  const d = store.data;
  return {
    settings: d.settings,
    marks: d.marks.slice(0, 200),
    reports: d.reports,
    groups: groupReports(d.reports),
    games: GAMES,
    routes: ROUTES,
    status: {
      hotkey: {
        mode: d.settings.hotkeyMode === 'hook' ? 'hook' : 'safe',
        started: d.settings.hotkeyMode === 'hook' ? hotkeys.started : safeOk,
        error: d.settings.hotkeyMode === 'hook' ? hotkeys.error : safeError,
        label: d.settings.hotkeyMode === 'hook' ? describe(d.settings.hotkey) : String(d.settings.safeHotkey || '').replace('Control', 'Ctrl'),
        bound: d.settings.hotkeyMode === 'hook' ? !!(d.settings.hotkey && d.settings.hotkey.keycode != null) : !!d.settings.safeHotkey,
        fallbackLabel: d.settings.fallbackHotkey,
        fallbackOk: fallbackRegistered
      },
      watcher: { ok: watcher.ok, dir: watcher.dir, error: watcher.error, recent: watcher.recent.length }
    },
    now: Date.now(),
    tz: TZ,
    version: app.getVersion(),
    update: updater ? updater.state : { status: 'disabled' },
    dataDir: app.getPath('userData'),
    logFile: logger.filePath()
  };
}

function broadcastSoon() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    send('state', publicState());
  }, 120);
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: ICON });
    n.on('click', () => { showWindow(); send('navigate', { tab: 'incidents' }); });
    n.show();
  } catch (e) { log('notify failed', e); }
}

// ------------------------------------------------------------------ incidents
function createMark(source) {
  const now = Date.now();
  const s = store.data.settings;
  const mark = {
    id: uid(),
    t: now,
    source,
    game: s.game,
    candidates: s.ocr.enabled && s.ocr.mode === 'always' ? ocr.candidates(now).map((c) => ({ name: c.name, frames: c.frames })) : [],
    watching: false,
    suspect: '',
    server: '',
    screenshot: null,
    clip: null,
    reportId: null
  };
  store.data.marks.unshift(mark);
  if (store.data.marks.length > 300) store.data.marks.length = 300;
  store.save();
  log('mark created', mark.id, source, `candidates=${mark.candidates.map((c) => c.name).join(',')}`);
  linkClips();
  const pressMode = s.ocr.enabled && s.ocr.region && s.ocr.mode !== 'always';
  const recMode = recordingReady();
  const names = mark.candidates.slice(0, 3).map((c) => c.name).join(', ');
  if (pressMode || recMode) {
    startWatch(mark, { ocr: pressMode, record: recMode });
    notify('Incident marked' + (recMode ? ' - recording' : ' - reading names'), `${fmtTime(now)} - press your key again to stop`);
  } else {
    notify('Incident marked', names ? `${fmtTime(now)} - names seen: ${names}` : `${fmtTime(now)} - saving clip link and screenshot`);
  }
  if (s.saveScreenshot) saveEvidence(mark).catch((e) => log('screenshot failed', e));
  broadcastSoon();
  return mark;
}

// Press-to-watch: the first key press marks the incident and starts reading the screen;
// the next press (or the time limit) stops reading and keeps the names it saw. Idle cost is zero.
let watch = null; // { id, timer, ocr, record }
function startWatch(mark, what) {
  const max = Math.min(600, Math.max(15, Number(store.data.settings.ocr.maxWatchSec) || 120));
  mark.watching = true;
  if (what.ocr) { ocr.names.clear(); ocr.names.windowMs = max * 1000 + 5000; }
  watch = { id: mark.id, ocr: !!what.ocr, record: !!what.record, timer: setTimeout(() => { endWatch('time limit').catch((e) => log('endWatch failed', e)); }, max * 1000) };
  if (what.ocr) ocr.start({ immediate: true }).catch((e) => log('ocr start failed', e));
  if (what.record) {
    startRecording(mark).then((r) => {
      if (!r.ok) {
        mark.recordError = r.error;
        notify('Could not record', r.error);
      } else if (watch && watch.id === mark.id) {
        mark.recording = true;
      }
      store.save();
      broadcastSoon();
    }).catch((e) => log('recording start failed', e));
  }
  log('watch started', mark.id, `max=${max}s ocr=${!!what.ocr} record=${!!what.record}`);
}

async function endWatch(reason) {
  if (!watch) return;
  const w = watch;
  watch = null;
  clearTimeout(w.timer);
  const mark = store.data.marks.find((m) => m.id === w.id);
  let video = null;
  if (w.record) video = await stopRecording().catch((e) => { log('recording stop failed', e); return null; });
  if (mark) {
    if (w.ocr) {
      let c = ocr.candidates(Date.now(), 2);
      if (!c.length) c = ocr.candidates(Date.now(), 1);
      mark.candidates = c.map((x) => ({ name: x.name, frames: x.frames }));
    }
    if (video) mark.video = video;
    mark.recording = false;
    mark.watching = false;
    mark.watchEnd = Date.now();
    store.save();
    log('watch ended', mark.id, reason, `candidates=${mark.candidates.map((x) => x.name).join(',')} video=${video ? video.file : 'none'}`);
    const names = mark.candidates.slice(0, 3).map((x) => x.name).join(', ');
    const bits = [];
    if (video) bits.push('Recording saved');
    if (w.ocr) bits.push(names ? `names seen: ${names}` : 'no names picked out');
    notify('Finished', bits.join(' - ') || 'Done');
  }
  if (w.ocr) { await ocr.stop(); ocr.names.windowMs = 45000; }
  broadcastSoon();
}

// ------------------------------------------------------------------ built-in recording (game window only)
let recorder = null; // { win, fd, file, startedAt, bytes, finish }

function recordingReady() {
  const s = store.data.settings;
  if (!(s.record && s.record.enabled)) return false;
  if (process.env.RK_FAKE_RECORD) return true;
  return s.record.source === 'window' ? !!s.ocr.gameWindow : true;
}

// 'screen': the whole display the game is on (smooth, 30 fps). 'window': only the game window (private, but
// Electron's window capture on Windows runs at about 15 fps).
let recTarget = { source: 'screen', displayId: null };

function pickRecordDisplay() {
  const want = store.data.settings.record.display;
  const all = screen.getAllDisplays();
  if (want && want !== 'auto') { const d = all.find((x) => String(x.id) === String(want)); if (d) return d; }
  // Automatic: the display the mouse is on (in a game that is the game's display), falling back to the primary one.
  try { return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); } catch (e) { return screen.getPrimaryDisplay(); }
}

function recordingsDir() {
  const d = (store.data.settings.record && store.data.settings.record.dir) || path.join(app.getPath('userData'), 'recordings');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function ensureRecorderWindow() {
  if (recorder && recorder.win && !recorder.win.isDestroyed()) return recorder.win;
  const ses = session.fromPartition('rapsheet-recorder');
  // The recorder may only ever be given the one game window the user chose. Anything else is refused.
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      if (recTarget.source === 'screen') {
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        const src = sources.find((x) => String(x.display_id) === String(recTarget.displayId)) || sources[0];
        return src ? cb({ video: src }) : cb({});
      }
      const gw = store.data.settings.ocr.gameWindow;
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      const name = pickWindowName(gw, sources.map((x) => x.name));
      const src = name && sources.find((x) => x.name === name);
      if (!src) return cb({});
      cb({ video: src });
    } catch (e) { cb({}); }
  }, { useSystemPicker: false });
  const rw = new BrowserWindow({
    show: false, width: 320, height: 200, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'recorder', 'recorderPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, partition: 'rapsheet-recorder', backgroundThrottling: false }
  });
  rw.loadFile(path.join(__dirname, 'recorder', 'recorder.html'));
  return rw;
}

async function startRecording(mark) {
  if (recorder && recorder.fd != null) return { ok: false, error: 'A recording is already running.' };
  const s = store.data.settings;
  const q = s.record.quality === '1080' ? { maxW: 1920, maxH: 1080, bps: 7000000 } : { maxW: 1280, maxH: 720, bps: 4000000 };
  const stamp = new Date(mark.t);
  const base = `Rap Sheet ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}-${pad(stamp.getMinutes())}-${pad(stamp.getSeconds())}`;
  const file = path.join(recordingsDir(), base + '.recording'); // renamed to .mp4 or .webm when finished
  const name = base;
  const rw = ensureRecorderWindow();
  recTarget = { source: s.record.source === 'window' ? 'window' : 'screen', displayId: null };
  if (recTarget.source === 'screen') recTarget.displayId = pickRecordDisplay().id;
  if (rw.webContents.isLoading()) await new Promise((r) => rw.webContents.once('did-finish-load', r));
  const fd = fs.openSync(file, 'w');
  recorder = { win: rw, fd, file, name, ext: '.webm', startedAt: Date.now(), bytes: 0, markId: mark.id, finish: null };
  const res = await rw.webContents.executeJavaScript(
    `window.__start(${JSON.stringify({ fps: 30, maxW: q.maxW, maxH: q.maxH, bps: q.bps, fake: !!process.env.RK_FAKE_RECORD, encoder: s.record.encoder || 'auto' })})`, true);
  if (!res || !res.ok) {
    try { fs.closeSync(fd); fs.unlinkSync(file); } catch (e) { /* ignore */ }
    recorder = null;
    const why = (res && res.error) || 'unknown error';
    log('recording failed to start', why);
    return { ok: false, error: /Permission|NotAllowed|denied|Invalid state|Could not start/i.test(why)
      ? 'Could not capture the screen or game window. If you chose game-window-only, check that the game is open (not minimized) and chosen in Settings.' : why };
  }
  recorder.startedAt = Date.now();
  recorder.ext = /mp4/i.test(res.mime) ? '.mp4' : '.webm';
  log('recording started', name, recTarget.source === 'screen' ? `screen display ${recTarget.displayId}` : 'game window', `${res.width}x${res.height}`, `${res.fps}fps`, res.mime, res.skipped && res.skipped.length ? `(skipped: ${res.skipped.join(', ')})` : '');
  return { ok: true };
}

async function stopRecording() {
  if (!recorder || recorder.fd == null) return null;
  const r = recorder;
  const done = new Promise((resolve) => { r.finish = resolve; setTimeout(resolve, 8000); });
  try { await r.win.webContents.executeJavaScript('window.__stop()', true); } catch (e) { /* window gone */ }
  await done;
  const durationSec = Math.max(1, Math.round((Date.now() - r.startedAt) / 1000));
  try { fs.closeSync(r.fd); } catch (e) { /* ignore */ }
  r.fd = null;
  if (!r.win.isDestroyed()) r.win.close();
  recorder = null;
  let size = 0;
  try { size = fs.statSync(r.file).size; } catch (e) { /* ignore */ }
  if (size < 1000) { try { fs.unlinkSync(r.file); } catch (e) { /* ignore */ } log('recording was empty, discarded'); return null; }
  const finalName = r.name + (r.ext || '.webm');
  const finalPath = path.join(path.dirname(r.file), finalName);
  try { fs.renameSync(r.file, finalPath); } catch (e) { log('could not rename recording', e); return { file: path.basename(r.file), path: r.file, durationSec, bytes: size }; }
  log('recording saved', finalName, `${Math.round(size / 1024)} KB`, `${durationSec}s`, `~${Math.round(size * 8 / 1000 / durationSec)} kbps`);
  return { file: finalName, path: finalPath, durationSec, bytes: size };
}

// Drag a clip or screenshot straight from Rap Sheet into Discord, a browser upload box or a folder.
ipcMain.on('file:drag', (e, p) => {
  try {
    const known = new Set();
    for (const m of store.data.marks) { if (m.clip) known.add(m.clip.path); if (m.video) known.add(m.video.path); if (m.screenshot) known.add(m.screenshot); }
    if (!p || !known.has(p) || !fs.existsSync(p)) return;
    const icon = nativeImage.createFromPath(ICON_PNG).resize({ width: 48, height: 48 });
    e.sender.startDrag({ file: p, icon });
  } catch (err) { log('drag failed', err); }
});

ipcMain.on('rec:chunk', (_e, ab) => {
  if (!recorder || recorder.fd == null) return;
  try { const b = Buffer.from(ab); fs.writeSync(recorder.fd, b); recorder.bytes += b.length; } catch (e) { log('recording write failed', e); }
});
ipcMain.on('rec:stats', (_e, st) => { try { log('recording stats:', `${st.frames} frames over ${st.seconds}s = ${st.fps} fps captured`); } catch (e) { /* ignore */ } });
ipcMain.on('rec:stopped', () => { if (recorder && recorder.finish) recorder.finish(); });

function debouncedMark(source) {
  const now = Date.now();
  if (now - lastMarkAt < 1500) return;
  lastMarkAt = now;
  if (watch) { endWatch('key').catch((e) => log('endWatch failed', e)); return; }
  createMark(source);
}

async function saveEvidence(mark) {
  const jpg = await capture.screenshotJpeg(store.data.settings.ocr.gameWindow);
  if (!jpg) return;
  const dir = path.join(app.getPath('userData'), 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `incident-${mark.id}.jpg`);
  fs.writeFileSync(file, jpg);
  mark.screenshot = file;
  store.save();
  broadcastSoon();
}

function linkClips() {
  const len = store.data.settings.replayLenSec;
  let changed = false;
  for (const m of store.data.marks) {
    if (m.clip || Date.now() - m.t > 30 * 60 * 1000) continue;
    const r = matchMarkToClip(m, watcher.recent, { fallbackLenSec: len });
    if (r) {
      m.clip = r;
      changed = true;
      log('clip linked', m.id, r.file, `offset=${Math.round(r.offsetSec)}s`);
      notify('Clip linked', `${r.file} - look between ${fmtClock(r.windowStartSec)} and ${fmtClock(r.windowEndSec)}`);
    }
  }
  if (changed) { store.save(); broadcastSoon(); }
}

// ------------------------------------------------------------------ apply settings
const ACCEL_RE = /^((Control|Ctrl|Alt|Shift)\+)*([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Insert|Delete|Home|End|PageUp|PageDown|Up|Down|Left|Right)$/;
function accelOk(a) {
  if (!ACCEL_RE.test(a)) return false;
  return /^F\d/.test(a.split('+').pop()) || /(Control|Ctrl|Alt|Shift)\+/.test(a); // a bare letter or digit would block typing everywhere
}

function unregisterSafe() {
  if (safeAcc) { try { globalShortcut.unregister(safeAcc); } catch (e) { /* ignore */ } }
  safeAcc = '';
  safeOk = false;
}

// Safe mode: Windows itself delivers the key (RegisterHotKey). No keyboard hook is installed.
function applySafe() {
  unregisterSafe();
  safeError = '';
  const acc = String(store.data.settings.safeHotkey || '').trim();
  if (!acc) { safeError = 'No key chosen.'; return false; }
  try {
    safeOk = globalShortcut.register(acc, () => debouncedMark('hotkey'));
    if (safeOk) safeAcc = acc; else safeError = 'Another program is already using ' + acc + '. Choose a different key.';
  } catch (e) {
    safeOk = false;
    safeError = 'That key could not be registered.';
    log('safe hotkey invalid', acc, e);
  }
  log('hotkeys: safe mode', acc, safeOk ? 'registered' : 'NOT registered');
  return safeOk;
}

function applyHotkey() {
  const s = store.data.settings;
  if (s.hotkeyMode === 'hook') {
    unregisterSafe();
    hotkeys.setBinding(s.hotkey);
    if (s.hotkey && s.hotkey.keycode != null) hotkeys.start();
  } else {
    hotkeys.setBinding(null);
    hotkeys.stop(); // safe mode never keeps a key hook running
    applySafe();
  }
}

function applyFallback() {
  if (fallbackAcc) {
    try { globalShortcut.unregister(fallbackAcc); } catch (e) { /* ignore */ }
    fallbackAcc = '';
  }
  fallbackRegistered = false;
  const acc = String(store.data.settings.fallbackHotkey || '').trim();
  if (!acc) return true;
  try {
    fallbackRegistered = globalShortcut.register(acc, () => debouncedMark('fallback'));
    if (fallbackRegistered) fallbackAcc = acc;
  } catch (e) {
    fallbackRegistered = false;
    log('fallback hotkey invalid', acc, e);
  }
  return fallbackRegistered;
}

function applyWatcher() {
  watcher.start(store.data.settings.recordingDir);
  broadcastSoon();
}

async function applyOcr() {
  const o = store.data.settings.ocr;
  if (watch) return; // a press-to-watch session is running; it stops itself
  if (o.enabled && o.region && o.mode === 'always') await ocr.start();
  else await ocr.stop();
}

function applyLoginItem() {
  try {
    app.setLoginItemSettings({ openAtLogin: !!store.data.settings.startWithWindows, args: ['--hidden'] });
  } catch (e) { log('login item failed', e); }
}

function sanitize(p) {
  const out = JSON.parse(JSON.stringify(p || {}));
  if (out.game !== undefined && !GAMES.includes(out.game)) delete out.game;
  if (out.hotkeyMode !== undefined && !['safe', 'hook'].includes(out.hotkeyMode)) delete out.hotkeyMode;
  if (out.safeHotkey !== undefined && !accelOk(String(out.safeHotkey))) delete out.safeHotkey;
  if (out.gameName !== undefined) out.gameName = String(out.gameName || '').trim().slice(0, 60);
  if (out.replayLenSec !== undefined) out.replayLenSec = Math.min(600, Math.max(10, Number(out.replayLenSec) || 90));
  if (out.ignoreNames !== undefined) {
    out.ignoreNames = (Array.isArray(out.ignoreNames) ? out.ignoreNames : String(out.ignoreNames).split(/[\n,]/))
      .map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
  }
  if (out.record) {
    if (out.record.quality !== undefined) out.record.quality = String(out.record.quality) === '1080' ? '1080' : '720';
    if (out.record.source !== undefined) out.record.source = out.record.source === 'window' ? 'window' : 'screen';
    if (out.record.display !== undefined) out.record.display = String(out.record.display || 'auto').slice(0, 40);
    if (out.record.encoder !== undefined && !['auto', 'h264', 'vp8'].includes(out.record.encoder)) out.record.encoder = 'auto';
    if (out.record.dir !== undefined) out.record.dir = String(out.record.dir || '').slice(0, 400);
  }
  if (out.ocr) {
    if (out.ocr.gameWindow !== undefined) out.ocr.gameWindow = String(out.ocr.gameWindow || '').trim().slice(0, 200);
    if (out.ocr.mode !== undefined && !['press', 'always'].includes(out.ocr.mode)) out.ocr.mode = 'press';
    if (out.ocr.maxWatchSec !== undefined) out.ocr.maxWatchSec = Math.min(600, Math.max(15, Number(out.ocr.maxWatchSec) || 120));
    if (out.ocr.intervalMs !== undefined) out.ocr.intervalMs = Math.min(10000, Math.max(1000, Number(out.ocr.intervalMs) || 2000));
    if (out.ocr.minConf !== undefined) out.ocr.minConf = Math.min(95, Math.max(30, Number(out.ocr.minConf) || 60));
  }
  return out;
}

// ------------------------------------------------------------------ region picker
// Shows the game window's own picture (nothing else) and lets the user drag a box on it.
// The box is saved as fractions of the window, so it survives resizing.
async function editRegion() {
  const r = await pickRegion();
  if (r.error) { notify('Reading area', r.error); return { ok: false, error: r.error }; }
  if (!r.region) return { ok: false, error: 'No area was selected.' };
  const o = store.data.settings.ocr;
  o.region = r.region;
  o.regionsByWindow = Object.assign({}, o.regionsByWindow, { [o.gameWindow]: r.region }); // remembered per game window
  store.save();
  broadcastSoon();
  return { ok: true, region: r.region };
}

async function pickRegion() {
  const gw = store.data.settings.ocr.gameWindow;
  const bd = await capture.windowBackdrop(gw);
  if (bd.error) return { error: bd.error };
  const wasVisible = win && win.isVisible();
  if (win) win.hide();
  let result = null;
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    // Fit the picture on screen without stretching it.
    const maxW = Math.floor(display.workAreaSize.width * 0.92), maxH = Math.floor(display.workAreaSize.height * 0.92);
    const k = Math.min(1, maxW / bd.width, maxH / bd.height);
    const box = { width: Math.round(bd.width * k), height: Math.round(bd.height * k) };
    // Start from the saved box so it can be moved or resized instead of redrawn from scratch.
    const cur = store.data.settings.ocr.region;
    const initial = cur && cur.rel ? { x: Math.round(cur.fx * box.width), y: Math.round(cur.fy * box.height), width: Math.round(cur.fw * box.width), height: Math.round(cur.fh * box.height) } : null;
    result = await openPicker(display, bd.dataUrl, box, initial);
    if (result) return { region: toFractions(result, box.width, box.height) };
  } catch (e) { log('region picker failed', e); }
  finally { if (wasVisible) showWindow(); }
  return { region: null };
}

function openPicker(display, backdrop, box, initial) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (rect) => {
      if (done) return;
      done = true;
      ipcMain.removeListener('picker:done', onDone);
      if (picker && !picker.isDestroyed()) picker.close();
      picker = null;
      resolve(rect);
    };
    const onDone = (_e, rect) => finish(rect);
    ipcMain.on('picker:done', onDone);
    picker = new BrowserWindow({
      x: display.bounds.x + Math.round((display.bounds.width - box.width) / 2), y: display.bounds.y + Math.round((display.bounds.height - box.height) / 2),
      width: box.width, height: box.height, useContentSize: true,
      frame: false, resizable: false, movable: false, skipTaskbar: true, fullscreenable: false, show: false,
      backgroundColor: '#000000',
      webPreferences: { preload: path.join(__dirname, 'picker', 'pickerPreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    picker.setAlwaysOnTop(true, 'screen-saver');
    picker.on('closed', () => finish(null));
    picker.loadFile(path.join(__dirname, 'picker', 'picker.html'));
    picker.webContents.once('did-finish-load', () => {
      picker.webContents.send('picker:init', { backdrop, width: box.width, height: box.height, initial });
      picker.show();
      picker.focus();
    });
  });
}

// ------------------------------------------------------------------ reports
function buildFromDraft(d) {
  const mark = d.markId ? store.data.marks.find((m) => m.id === d.markId) : null;
  const history = d.player ? historyFor(d.player, store.data.reports, d.reportId) : null;
  const clip = mark && mark.clip ? mark.clip : null;
  const gameLabel = d.game === 'Other' && store.data.settings.gameName ? store.data.settings.gameName : d.game;
  const text = buildReport({
    game: gameLabel, t: d.t, tz: TZ, server: d.server, player: d.player, behaviors: d.behaviors || [],
    desc: d.desc, witnesses: d.witnesses, clip, video: mark && mark.video, screenshotFile: mark && mark.screenshot, history
  });
  return { text, history, route: ROUTES[d.game] || ROUTES.Other, clip, video: (mark && mark.video) || null, screenshot: (mark && mark.screenshot) || null, markId: mark ? mark.id : null };
}

// ------------------------------------------------------------------ IPC
function registerIpc() {
  const h = (name, fn) => ipcMain.handle(name, async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { log('ipc error', name, e); return { ok: false, error: String((e && e.message) || e) }; }
  });

  h('state:get', () => publicState());

  // Rap Sheet's own CPU and memory, summed over all of its processes, so the user can see what it costs.
  h('usage:get', () => {
    const m = app.getAppMetrics();
    const cpu = m.reduce((a, p) => a + (p.cpu ? p.cpu.percentCPUUsage : 0), 0);
    const mem = m.reduce((a, p) => a + (p.memory ? p.memory.workingSetSize : 0), 0); // KB
    return { ok: true, cpuPercent: Math.round(cpu * 10) / 10, memMB: Math.round(mem / 1024), processes: m.length, reading: !!(ocr && ocr.running) };
  });

  h('settings:update', async (partial) => {
    const p = sanitize(partial);
    const switching = p.ocr && p.ocr.gameWindow !== undefined && p.ocr.gameWindow !== store.data.settings.ocr.gameWindow;
    if (p.ocr) delete p.ocr.region; // the area is only ever set by the editor or by the per-window memory below
    store.updateSettings(p);
    if (switching) {
      const o = store.data.settings.ocr;
      o.region = (o.regionsByWindow && o.regionsByWindow[o.gameWindow]) || null;
      store.save();
    }
    if (p.hotkey !== undefined || p.hotkeyMode !== undefined || p.safeHotkey !== undefined) applyHotkey();
    if (p.fallbackHotkey !== undefined) applyFallback();
    if (p.recordingDir !== undefined) applyWatcher();
    if (p.ocr !== undefined) await applyOcr();
    if (p.startWithWindows !== undefined) applyLoginItem();
    if (p.replayLenSec !== undefined) linkClips();
    broadcastSoon();
    return { ok: true, fallbackOk: fallbackRegistered };
  });

  h('hotkey:pause', () => { unregisterSafe(); return { ok: true }; });
  h('hotkey:resume', () => { applyHotkey(); broadcastSoon(); return { ok: true }; });
  h('hotkey:setSafe', (acc) => {
    const a = String(acc || '');
    if (!accelOk(a)) { applyHotkey(); return { ok: false, error: 'That key cannot be used. Try an F key (F5, F8...) or a letter with Ctrl, Alt or Shift.' }; }
    store.updateSettings({ safeHotkey: a, hotkeyMode: 'safe' });
    const ok = applySafe();
    broadcastSoon();
    return ok ? { ok: true, label: a.replace('Control', 'Ctrl') } : { ok: false, error: safeError };
  });

  h('hotkey:capture', async () => {
    const b = await hotkeys.beginCapture(15000);
    if (!b) return { ok: false, error: hotkeys.error || 'No key was pressed in time. Try again.' };
    store.updateSettings({ hotkey: b });
    applyHotkey();
    broadcastSoon();
    return { ok: true, binding: b, label: describe(b) };
  });

  h('region:pick', () => editRegion());

  h('windows:list', async () => ({ ok: true, windows: await capture.listWindows() }));

  h('ocr:test', async () => {
    const r = await ocr.readOnce();
    if (r.ok) {
      const probe = new (require('./lib/ocrNames').RollingNames)();
      const now = Date.now();
      probe.add(now, r.tokens);
      probe.add(now + 1, r.tokens);
      r.candidates = probe.top(now + 2, { minFrames: 1, ignore: store.data.settings.ignoreNames }).map((c) => c.name);
    }
    await ocr.releaseIfIdle();
    send('ocr', ocr.snapshot());
    r.preview = ocr.preview;
    return r;
  });

  h('folder:detect', () => {
    const videos = app.getPath('videos');
    const home = app.getPath('home');
    const cands = [videos, path.join(videos, 'Streamlabs'), path.join(videos, 'Streamlabs Desktop'), path.join(videos, 'OBS'),
      path.join(home, 'Videos'), path.join(home, 'Videos', 'Streamlabs')];
    return { ok: true, dir: detectRecordingDir([...new Set(cands)]) };
  });

  h('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose your recording folder' });
    return { ok: !r.canceled && r.filePaths.length > 0, dir: r.filePaths[0] || '' };
  });

  h('mark:manual', () => {
    if (watch) { endWatch('button').catch((e) => log('endWatch failed', e)); return { ok: true, stopped: true }; }
    return { ok: true, mark: createMark('manual') };
  });

  h('mark:update', (id, patch) => {
    const m = store.data.marks.find((x) => x.id === id);
    if (!m) return { ok: false };
    if (typeof patch.suspect === 'string') m.suspect = patch.suspect.slice(0, 60);
    if (typeof patch.server === 'string') m.server = patch.server.slice(0, 80);
    if (typeof patch.game === 'string' && GAMES.includes(patch.game)) m.game = patch.game;
    store.save();
    broadcastSoon();
    return { ok: true };
  });

  h('mark:delete', (id) => {
    store.data.marks = store.data.marks.filter((m) => m.id !== id);
    store.save();
    broadcastSoon();
    return { ok: true };
  });

  h('data:clearMarks', () => {
    store.data.marks = [];
    store.save();
    broadcastSoon();
    return { ok: true };
  });

  h('report:build', (d) => ({ ok: true, ...buildFromDraft(d) }));

  h('report:save', (d) => {
    const b = buildFromDraft(d);
    const now = Date.now();
    let rep = d.reportId ? store.data.reports.find((r) => r.id === d.reportId) : null;
    const fields = {
      t: d.t || now, game: d.game, server: d.server || '', player: (d.player || '').trim(),
      behaviors: d.behaviors || [], desc: d.desc || '', witnesses: d.witnesses || '', markId: d.markId || null,
      clipFile: b.clip ? b.clip.file : '', text: b.text
    };
    if (rep) Object.assign(rep, fields);
    else {
      rep = { id: uid(), createdAt: now, ...fields };
      store.data.reports.unshift(rep);
    }
    const mark = d.markId ? store.data.marks.find((m) => m.id === d.markId) : null;
    if (mark) { mark.reportId = rep.id; if (rep.player) mark.suspect = rep.player; }
    store.save();
    broadcastSoon();
    return { ok: true, id: rep.id };
  });

  h('report:delete', (id) => {
    store.data.reports = store.data.reports.filter((r) => r.id !== id);
    for (const m of store.data.marks) if (m.reportId === id) m.reportId = null;
    store.save();
    broadcastSoon();
    return { ok: true };
  });

  h('clipboard:write', (t) => { clipboard.writeText(String(t || '')); return { ok: true }; });
  // Pick the clip or screenshot for an incident yourself (opens a normal file picker).
  h('mark:attach', async (id, kind) => {
    const m = store.data.marks.find((x) => x.id === id);
    if (!m) return { ok: false, error: 'Incident not found.' };
    const isShot = kind === 'screenshot';
    const s = store.data.settings;
    const startDir = isShot ? path.join(app.getPath('userData'), 'evidence') : (s.recordingDir || recordingsDir());
    const r = await dialog.showOpenDialog(win, {
      title: isShot ? 'Choose a screenshot' : 'Choose a clip or recording',
      defaultPath: fs.existsSync(startDir) ? startDir : undefined,
      properties: ['openFile'],
      filters: isShot
        ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }, { name: 'All files', extensions: ['*'] }]
        : [{ name: 'Videos', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi'] }, { name: 'All files', extensions: ['*'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const p = r.filePaths[0];
    if (isShot) m.screenshot = p;
    else m.clip = { file: path.basename(p), path: p, offsetSec: null, windowStartSec: null, windowEndSec: null, durationKnown: false, manual: true };
    store.save();
    broadcastSoon();
    return { ok: true, file: path.basename(p) };
  });

  h('record:chooseDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: 'Where should recordings be saved?' });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    store.updateSettings({ record: { dir: r.filePaths[0] } });
    broadcastSoon();
    return { ok: true, dir: r.filePaths[0] };
  });
  h('displays:list', () => {
    const prim = screen.getPrimaryDisplay().id;
    return { ok: true, displays: screen.getAllDisplays().map((d, i) => ({ id: String(d.id), label: `Display ${i + 1}: ${d.size.width}x${d.size.height}${d.id === prim ? ' (main)' : ''}` })) };
  });
  h('record:openDir', async () => { await shell.openPath(recordingsDir()); return { ok: true }; });

  h('shell:show', (p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); return { ok: true }; });
  h('shell:openLog', async () => { const f = logger.filePath(); if (f) await shell.openPath(f); return { ok: true }; });
  h('shell:openData', async () => { await shell.openPath(app.getPath('userData')); return { ok: true }; });
  h('update:check', async () => (updater ? updater.check() : { status: 'disabled' }));
  h('update:install', () => ({ ok: !!(updater && updater.install()) }));
  h('log:recent', async () => {
    let gpu = 'unknown';
    try {
      const g = await app.getGPUInfo('basic');
      const VEND = { 4318: 'NVIDIA', 4098: 'AMD', 32902: 'Intel', 5140: 'Microsoft (software)' };
      gpu = ((g.gpuDevice || []).map((d) => `${VEND[d.vendorId] || d.vendorId} ${d.deviceId}${d.active ? ' (active)' : ''}`).join(', ')) + (g.auxAttributes && g.auxAttributes.glRenderer ? ' | ' + g.auxAttributes.glRenderer : '');
    } catch (e) { /* best effort */ }
    const st = store.data.settings;
    const head = [
      `Rap Sheet ${app.getVersion()} | Windows build ${require('os').release()} ${process.arch} | Electron ${process.versions.electron}`,
      `GPU: ${gpu}`,
      `Game: ${st.game}${st.gameName ? ' (' + st.gameName + ')' : ''} | window: ${(st.ocr && st.ocr.gameWindow) || '-'} | reading: ${st.ocr && st.ocr.enabled ? st.ocr.mode : 'off'}`,
      `Recording: ${st.record && st.record.enabled ? 'on' : 'off'} ${st.record && st.record.source}/${st.record && st.record.quality}p/${st.record && st.record.encoder} | hotkey: ${st.hotkeyMode === 'hook' ? 'key hook ' + ((st.hotkey && st.hotkey.name) || '-') : 'safe ' + st.safeHotkey}${st.hotkey && st.hotkey.alt ? ' +Alt' : ''}${st.hotkey && st.hotkey.ctrl ? ' +Ctrl' : ''}${st.hotkey && st.hotkey.shift ? ' +Shift' : ''}`,
      '--- log ---'
    ].join('\n');
    const home = require('os').homedir();
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const scrub = (t) => (home ? t.replace(new RegExp(esc(home), 'gi'), '%USERPROFILE%').replace(new RegExp(esc(home.replace(/\\/g, '/')), 'gi'), '%USERPROFILE%') : t);
    return scrub(head + '\n' + logger.recent().join('\n'));
  });
}

// ------------------------------------------------------------------ window / tray
function createWindow(showNow) {
  win = new BrowserWindow({
    width: 1060, height: 780, minWidth: 780, minHeight: 560, show: false, title: 'Rap Sheet', icon: ICON,
    backgroundColor: '#11181D',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (showNow) win.show(); });
  win.on('close', (e) => {
    if (!quitting && store.data.settings.minimizeToTray) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  try {
    // Sharp at every Windows display scale: 100%, 150%, 200%, 300%.
    const img = nativeImage.createEmpty();
    [[1, 16], [1.5, 24], [2, 32], [3, 48]].forEach(([scaleFactor, px]) => {
      img.addRepresentation({ scaleFactor, buffer: fs.readFileSync(path.join(__dirname, '..', 'assets', `tray${px}.png`)) });
    });
    tray = new Tray(img);
    tray.setToolTip('Rap Sheet');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Rap Sheet', click: showWindow },
      { label: 'Mark incident now', click: () => debouncedMark('tray') },
      { label: 'Move reading area...', click: () => { editRegion().catch((e) => log('editRegion failed', e)); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', showWindow);
  } catch (e) { log('tray failed', e); }
}

// ------------------------------------------------------------------ boot
function boot() {
  Menu.setApplicationMenu(null);
  app.setAppUserModelId('com.rapsheet.app');
  logger.init(app.getPath('userData'));
  log('Rap Sheet starting', app.getVersion(), process.platform, process.arch, 'electron', process.versions.electron);

  store = new Store(app.getPath('userData'));
  store.load();

  hotkeys = new Hotkeys();
  hotkeys.on('mark', () => debouncedMark('hotkey'));

  watcher = new ClipWatcher();
  watcher.on('clip', () => { linkClips(); broadcastSoon(); });

  const fakeCapture = process.env.RK_FAKE_CAPTURE; // test hook: read a PNG instead of the screen
  ocr = new OcrLoop({
    getSettings: () => store.data.settings,
    isRecording: () => !!(recorder && recorder.fd != null),
    langPath: LANG_PATH,
    onUpdate: () => send('ocr', ocr.snapshot()),
    capture: async () => {
      const s = store.data.settings.ocr;
      if (fakeCapture) {
        const png = fs.readFileSync(fakeCapture);
        return { png, previewDataUrl: 'data:image/png;base64,' + png.toString('base64') };
      }
      return capture.captureRegion(s.region, s.scale, s.gameWindow);
    }
  });

  updater = new (require('./updater').Updater)({ app, onChange: () => broadcastSoon() });
  registerIpc();
  applyHotkey();
  applyFallback();
  applyWatcher();
  applyLoginItem();

  const hiddenStart = process.argv.includes('--hidden') && store.data.settings.firstRunDone;
  createWindow(!hiddenStart);
  createTray();
  applyOcr();
  updater.start();

  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.on('before-quit', () => {
    quitting = true;
    store.flush();
    hotkeys.stop();
    ocr.stop();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());

  if (process.env.RK_SMOKE) {
    require('./smoke').run({ app, store, createMark, press: () => debouncedMark('smoke'), recorderIdle: () => !recorder, openPicker, pickerWin: () => picker, regionTools: require('./lib/region'), watcher, ocr, linkClips, hotkeys: () => hotkeys, win: () => win, publicState });
  }
}

// The recorder lives in a hidden window. Keep Chromium from slowing it down because nobody can see it,
// which would show up as dropped frames (stutter) in the saved video.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(boot);
}
