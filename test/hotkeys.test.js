'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Hotkeys } = require('../src/hotkeys');

const KEYS = { F5: 63, Alt: 56, AltRight: 3640, Ctrl: 29, Shift: 42 };
function make(binding) {
  const hk = new Hotkeys();
  hk.keys = KEYS; // stand-in for the keyboard library's key table
  hk.setBinding(binding);
  hk.fired = 0;
  hk.on('mark', () => { hk.fired++; });
  return hk;
}
const plain = { keycode: 63, name: 'F5', ctrl: false, alt: false, shift: false, meta: false };

test('plain F5 fires even when the library wrongly reports Alt as held (stuck after Alt+Tab)', () => {
  const hk = make(plain);
  hk._onKeyDown({ keycode: 63, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false });
  assert.equal(hk.fired, 1);
});

test('plain F5 still fires if the user really holds Alt too', () => {
  const hk = make(plain);
  hk._onKeyDown({ keycode: 56 });
  hk._onKeyDown({ keycode: 63, altKey: true });
  assert.equal(hk.fired, 1);
});

test('an Alt+F5 binding needs Alt really held, not just a stuck flag', () => {
  const hk = make({ ...plain, alt: true });
  hk._onKeyDown({ keycode: 63, altKey: true });
  assert.equal(hk.fired, 0);
  hk._onKeyDown({ keycode: 56 });
  hk.lastFire = 0;
  hk._onKeyDown({ keycode: 63, altKey: true });
  assert.equal(hk.fired, 1);
  hk.down.delete('Alt');
  hk.lastFire = 0;
  hk._onKeyDown({ keycode: 63, altKey: true });
  assert.equal(hk.fired, 1);
});

test('capturing F5 with a stuck Alt flag records plain F5, not Alt+F5', async () => {
  const hk = make(null);
  hk.started = true;
  const p = hk.beginCapture(2000);
  hk._onKeyDown({ keycode: 63, altKey: true, ctrlKey: false, shiftKey: false, metaKey: false });
  const b = await p;
  assert.equal(b.name, 'F5');
  assert.equal(b.alt, false);
});

test('capturing Ctrl+F5 keeps Ctrl when it was really pressed', async () => {
  const hk = make(null);
  hk.started = true;
  const p = hk.beginCapture(2000);
  hk._onKeyDown({ keycode: 29 });
  hk._onKeyDown({ keycode: 63, ctrlKey: true });
  const b = await p;
  assert.equal(b.ctrl, true);
  assert.equal(b.alt, false);
});

test('other keys never fire the binding', () => {
  const hk = make(plain);
  hk._onKeyDown({ keycode: 64 });
  assert.equal(hk.fired, 0);
});
