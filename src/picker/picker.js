'use strict';
// Reading-area editor over a frozen picture of the game window.
// Drag the box to move it, drag its edges or corners to resize, drag on empty space to draw a new one.
// Arrow keys nudge it (hold Shift for bigger steps). Enter saves, Esc cancels.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var bg = $('bg'), sel = $('sel'), dim = $('dim'), hint = $('hint'), bar = $('bar');
  var W = window.innerWidth, H = window.innerHeight;
  var MIN_W = 20, MIN_H = 12;
  var rect = null, mode = null, start = null, orig = null;

  ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (k) {
    var d = document.createElement('div'); d.className = 'h'; d.setAttribute('data-h', k); sel.appendChild(d);
  });

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function fix(r) {
    var x = clamp(r.x, 0, W - MIN_W), y = clamp(r.y, 0, H - MIN_H);
    return { x: x, y: y, width: clamp(r.width, MIN_W, W - x), height: clamp(r.height, MIN_H, H - y) };
  }
  function draw() {
    var has = !!rect;
    sel.hidden = !has; bar.hidden = !has; dim.style.display = has ? 'none' : '';
    if (!has) return;
    sel.style.left = rect.x + 'px'; sel.style.top = rect.y + 'px';
    sel.style.width = rect.width + 'px'; sel.style.height = rect.height + 'px';
  }
  function say() {
    hint.textContent = rect
      ? 'Drag the box to move it. Drag its edges or corners to resize. Drag on empty space to draw a new one. Arrow keys nudge it. Enter saves, Esc cancels.'
      : 'Drag a box around where player names appear in the game (kill feed, nameplates). Press Esc to cancel.';
  }
  function pt(e) { return { x: clamp(e.clientX, 0, W), y: clamp(e.clientY, 0, H) }; }

  window.pk.onInit(function (info) {
    bg.src = info.backdrop;
    W = info.width || window.innerWidth; H = info.height || window.innerHeight;
    if (info.initial && info.initial.width > 4) rect = fix(info.initial);
    draw(); say();
  });

  window.addEventListener('pointerdown', function (e) {
    if (e.target.closest && e.target.closest('#bar')) return;
    var p = pt(e);
    var h = e.target.getAttribute && e.target.getAttribute('data-h');
    if (rect && h) { mode = 'resize:' + h; }
    else if (rect && e.target === sel) { mode = 'move'; }
    else { mode = 'draw'; rect = { x: p.x, y: p.y, width: 0, height: 0 }; }
    start = p; orig = rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    sel.hidden = false; dim.style.display = 'none';
    draw();
    e.preventDefault();
  });

  window.addEventListener('pointermove', function (e) {
    if (!mode) return;
    var p = pt(e), dx = p.x - start.x, dy = p.y - start.y;
    if (mode === 'draw') {
      rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) };
    } else if (mode === 'move') {
      rect = { x: clamp(orig.x + dx, 0, W - orig.width), y: clamp(orig.y + dy, 0, H - orig.height), width: orig.width, height: orig.height };
    } else {
      var k = mode.split(':')[1];
      var l = orig.x, t = orig.y, r = orig.x + orig.width, b = orig.y + orig.height;
      if (k.indexOf('w') >= 0) l = clamp(orig.x + dx, 0, r - MIN_W);
      if (k.indexOf('e') >= 0) r = clamp(r + dx, l + MIN_W, W);
      if (k.indexOf('n') >= 0) t = clamp(orig.y + dy, 0, b - MIN_H);
      if (k.indexOf('s') >= 0) b = clamp(b + dy, t + MIN_H, H);
      rect = { x: l, y: t, width: r - l, height: b - t };
    }
    draw();
  });

  window.addEventListener('pointerup', function () {
    if (!mode) return;
    if (mode === 'draw' && rect && (rect.width < MIN_W || rect.height < MIN_H)) rect = null; // too small: try again
    mode = null; draw(); say();
  });

  function save() { if (rect) window.pk.done({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }); }
  $('b-save').addEventListener('click', save);
  $('b-cancel').addEventListener('click', function () { window.pk.done(null); });
  $('b-redraw').addEventListener('click', function () { rect = null; draw(); say(); });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { window.pk.done(null); return; }
    if (e.key === 'Enter') { save(); return; }
    if (!rect) return;
    var step = e.shiftKey ? 10 : 1, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    rect = { x: clamp(rect.x + d[0], 0, W - rect.width), y: clamp(rect.y + d[1], 0, H - rect.height), width: rect.width, height: rect.height };
    draw(); e.preventDefault();
  });

  say();
})();
