'use strict';
// Passive global key listener (does NOT swallow keys and does NOT inject input).
// You bind "Save Replay" to a key in Streamlabs; this listens for the same key and stamps an incident mark.
const { EventEmitter } = require('events');
const { log } = require('./logger');

const MODIFIER_NAMES = new Set(['Ctrl', 'CtrlRight', 'Shift', 'ShiftRight', 'Alt', 'AltRight', 'Meta', 'MetaRight']);

class Hotkeys extends EventEmitter {
  constructor() {
    super();
    this.hook = null;
    this.keys = null;
    this.binding = null;
    this.started = false;
    this.error = null;
    this.lastFire = 0;
    this._capture = null;
    this.down = new Set(); // modifier keys we have actually seen go down (the library's own flags can get stuck after Alt+Tab)
    this.logged = 0;
    this.seen = 0;
  }

  mods() {
    const d = this.down;
    return { ctrl: d.has('Ctrl') || d.has('CtrlRight'), alt: d.has('Alt') || d.has('AltRight'), shift: d.has('Shift') || d.has('ShiftRight'), meta: d.has('Meta') || d.has('MetaRight') };
  }

  start() {
    if (this.started) return true;
    try {
      const mod = require('uiohook-napi');
      this.hook = mod.uIOhook;
      this.keys = mod.UiohookKey;
      this.hook.on('keydown', (e) => this._onKeyDown(e));
      this.hook.on('keyup', (e) => { const n = this.keyName(e.keycode); if (MODIFIER_NAMES.has(n)) this.down.delete(n); });
      this.hook.start();
      this.started = true;
      this.error = null;
      log('hotkeys: global key listener started');
      return true;
    } catch (e) {
      this.error = String((e && e.message) || e);
      log('hotkeys: could not start key listener:', e);
      return false;
    }
  }

  stop() {
    if (this.hook && this.started) {
      try { this.hook.stop(); } catch (e) { /* ignore */ }
    }
    this.started = false;
  }

  setBinding(b) {
    this.binding = b && typeof b.keycode === 'number' ? b : null;
  }

  keyName(code) {
    if (!this.keys) return String(code);
    for (const [name, val] of Object.entries(this.keys)) {
      if (val === code) return name;
    }
    return String(code);
  }

  // Resolves with the next non-modifier key pressed (with its modifiers), or null on timeout.
  beginCapture(timeoutMs = 15000) {
    return new Promise((resolve) => {
      if (!this.started && !this.start()) { resolve(null); return; }
      const timer = setTimeout(() => { this._capture = null; resolve(null); }, timeoutMs);
      this._capture = (e) => {
        const name = this.keyName(e.keycode);
        if (MODIFIER_NAMES.has(name)) return false;
        clearTimeout(timer);
        this._capture = null;
        const m = this.mods();
        log('hotkeys: captured', name, JSON.stringify({ libFlags: { c: !!e.ctrlKey, a: !!e.altKey, s: !!e.shiftKey, w: !!e.metaKey }, tracked: m }));
        // Only keep a modifier if it was really held down (flag AND our own tracking agree).
        resolve({
          keycode: e.keycode,
          name,
          ctrl: !!e.ctrlKey && m.ctrl,
          alt: !!e.altKey && m.alt,
          shift: !!e.shiftKey && m.shift,
          meta: !!e.metaKey && m.meta
        });
        return true;
      };
    });
  }

  cancelCapture() { this._capture = null; }

  _onKeyDown(e) {
    const kn = this.keyName(e.keycode);
    if (MODIFIER_NAMES.has(kn)) { this.down.add(kn); return; }
    if (this._capture) {
      this._capture(e);
      return;
    }
    const b = this.binding;
    if (!b) return;
    if (e.keycode !== b.keycode) return;
    if (this.seen++ < 12) log('hotkeys: bound key pressed', JSON.stringify({ key: b.name, bindingMods: { c: !!b.ctrl, a: !!b.alt, s: !!b.shift, w: !!b.meta }, libFlags: { c: !!e.ctrlKey, a: !!e.altKey, s: !!e.shiftKey, w: !!e.metaKey }, tracked: this.mods() }));
    // The modifiers the binding asks for must be held. Extra ones (or a stuck Alt) never block it.
    const m = this.mods();
    if ((b.ctrl && !m.ctrl) || (b.alt && !m.alt) || (b.shift && !m.shift) || (b.meta && !m.meta)) {
      if (this.logged++ < 5) log('hotkeys: key matched but a required modifier was not held', JSON.stringify({ need: { c: !!b.ctrl, a: !!b.alt, s: !!b.shift, w: !!b.meta }, held: m }));
      return;
    }
    const now = Date.now();
    if (now - this.lastFire < 1500) return; // ignore key repeat while held
    this.lastFire = now;
    this.emit('mark');
  }
}

function describe(b) {
  if (!b || !b.name) return '';
  const parts = [];
  if (b.ctrl) parts.push('Ctrl');
  if (b.alt) parts.push('Alt');
  if (b.shift) parts.push('Shift');
  if (b.meta) parts.push('Win');
  parts.push(b.name);
  return parts.join('+');
}

module.exports = { Hotkeys, describe };
