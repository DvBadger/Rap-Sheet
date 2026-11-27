(function () {
  'use strict';
  var rk = window.rk;

  /* ------------------------------------------------------------ helpers */
  function $(sel, root) { return (root || document).querySelector(sel); }

  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.appendChild(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function fmtTime(t) { var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function fmtDay(t) { var d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtDT(t) { return fmtDay(t) + ' ' + fmtTime(t).slice(0, 5); }
  function toLocalInput(t) { var d = new Date(t); return fmtDay(t) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fmtClock(sec) {
    var s = Math.max(0, Math.round(sec)), hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return hh > 0 ? hh + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
  }
  function flash(btn, text) {
    var label = btn.getAttribute('data-label') || btn.textContent;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = label; }, 1400);
  }

  var BEHAVIORS = [
    ['seeing through walls (ESP / wallhack)', 'Seeing through walls'],
    ['inhuman aim (aimbot / snapping)', 'Inhuman aim'],
    ['no recoil / perfect spray control', 'No recoil'],
    ['speed or teleport movement', 'Speed or teleport'],
    ['items or money appearing without a source', 'Item or money gain'],
    ['other (see description)', 'Other']
  ];

  /* ------------------------------------------------------------ state */
  var S = null;          // latest app state from the main process
  var OCR = null;        // latest screen-reading status
  var tab = 'incidents';
  var draft = null;      // the report being edited
  var draftWhen = '';
  var pendingIncRender = false;
  var wizStep = 0;
  var wizMarkBase = 0;
  var wizMsg = '';
  var wizResult = null;
  var previewTimer = null;
  var previewSeq = 0;

  // Fills a <select> with the open windows so the user can choose the game. Only that window is ever read.
  function fillWindowSelect(sel, msg) {
    if (!sel) return;
    rk.windows().then(function (r) {
      var cur = S.settings.ocr.gameWindow || '';
      var list = (r && r.windows) || [];
      sel.textContent = '';
      sel.appendChild(h('option', { value: '', text: list.length ? 'Choose your game window...' : 'No windows found' }));
      if (cur && list.indexOf(cur) < 0) sel.appendChild(h('option', { value: cur, text: cur + ' (not open right now)' }));
      list.forEach(function (n) { sel.appendChild(h('option', { value: n, text: n })); });
      sel.value = cur;
      if (msg) msg.textContent = cur ? 'Only "' + cur + '" is read. Nothing else on screen is captured.' : 'Start your game, then choose its window here.';
    });
  }

  var usageTimer = null;
  function pollUsage() {
    if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
    var el = $('#st-usage');
    if (!el) return;
    function once() {
      rk.usage().then(function (u) {
        if (!u || !u.ok) return;
        el.textContent = 'Rap Sheet is using about ' + u.cpuPercent + '% CPU and ' + u.memMB + ' MB of memory right now'
          + (u.reading ? ' (reading names).' : ' (idle).');
      });
    }
    once();
    usageTimer = setInterval(once, 2000);
  }
  // Pick the incident key. Safe mode: press the key in this window (the shortcut is paused meanwhile, because a
  // registered shortcut would swallow the key). Advanced mode: the key hook captures it system-wide.
  function pickKey() {
    var hk = S && S.status && S.status.hotkey;
    if (hk && hk.mode === 'hook') return rk.captureHotkey();
    return rk.pauseHotkey().then(function () {
      return new Promise(function (resolve) {
        var done = false;
        function finish(r) {
          if (done) return; done = true;
          window.removeEventListener('keydown', onKey, true);
          clearTimeout(t);
          resolve(r);
        }
        function accel(e) {
          var k = e.key, c = e.code, name = '';
          if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) name = k;
          else if (/^Key[A-Z]$/.test(c)) name = c.slice(3);
          else if (/^Digit[0-9]$/.test(c)) name = c.slice(5);
          else if (k === ' ') name = 'Space';
          else if (['Tab', 'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'].indexOf(k) >= 0) name = k;
          else if (/^Arrow(Up|Down|Left|Right)$/.test(k)) name = k.slice(5);
          if (!name) return '';
          return (e.ctrlKey ? 'Control+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + name;
        }
        function onKey(e) {
          if (['Control', 'Alt', 'Shift', 'Meta'].indexOf(e.key) >= 0) return;
          e.preventDefault(); e.stopPropagation();
          if (e.key === 'Escape') { finish({ ok: false, error: 'Cancelled.' }); return; }
          var a = accel(e);
          if (!a) { finish({ ok: false, error: 'That key cannot be used. Try an F key such as F5.' }); return; }
          finish(rk.setSafeHotkey(a));
        }
        window.addEventListener('keydown', onKey, true);
        var t = setTimeout(function () { finish({ ok: false, error: 'No key was pressed in time. Try again.' }); }, 15000);
      });
    }).then(function (r) { return Promise.resolve(r).then(function (res) { return rk.resumeHotkey().then(function () { return res; }); }); });
  }

  function setTab(name) {
    if (name === 'settings') pollUsage();
    else if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
    tab = name;
    ['incidents', 'report', 'offenders', 'settings', 'help'].forEach(function (t) { $('#tab-' + t).hidden = t !== name; });
    Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    if (name === 'help') {
      var hk0 = S && S.status && S.status.hotkey;
      Array.prototype.forEach.call(document.querySelectorAll('.hk-label'), function (el) { el.textContent = hk0 && hk0.bound ? hk0.label : 'your hotkey'; });
    }
    if (name === 'report') { if (!draft) newDraft(null); schedulePreview(); }
  }

  /* ------------------------------------------------------------ pills + live panel */
  function pill(kind, text) { return h('button', { type: 'button', class: 'pill ' + kind, onclick: function () { setTab('settings'); } }, text); }

  function renderPills() {
    var box = $('#pills');
    box.textContent = '';
    var hk = S.status.hotkey, w = S.status.watcher, o = OCR || { status: 'off' };
    box.appendChild(pill(hk.bound ? (hk.started ? 'ok' : 'warn') : 'warn',
      hk.bound ? 'Hotkey: ' + hk.label + (hk.started ? '' : ' (not listening)') : 'Set your hotkey'));
    box.appendChild(pill(w.ok ? 'ok' : 'warn', w.ok ? 'Watching clips' : 'Choose clips folder'));
    var on = S.settings.ocr.enabled, always = S.settings.ocr.mode === 'always';
    var kind = !on ? 'off' : o.status === 'running' ? 'ok' : o.status === 'error' ? 'warn' : always ? 'off' : 'ok';
    var text = !on ? 'Screen reading off'
      : o.status === 'error' ? 'Screen reading problem'
      : o.status === 'running' ? (always ? 'Screen reading on' : 'Reading names now')
      : o.status === 'starting' ? 'Screen reading starting'
      : always ? 'Screen reading starting' : 'Reads names when you press your key';
    box.appendChild(pill(kind, text));
  }

  function renderLive() {
    if (!S) return;
    var on = S.settings.ocr.enabled;
    var o = OCR || { status: S.settings.ocr.mode === 'always' ? 'starting' : 'off', candidates: [] };
    $('#live').hidden = !on || (S.settings.ocr.mode !== 'always' && o.status === 'off');
    if ($('#live').hidden) return;
    var tag = $('#live-status');
    tag.className = 'tag' + (o.status === 'running' ? ' ok' : o.status === 'error' ? ' bad' : '');
    tag.textContent = o.status === 'running' ? 'Reading' : o.status === 'error' ? 'Problem: ' + (o.error || 'unknown') : 'Starting...';
    var img = $('#live-img');
    if (o.preview) { img.src = o.preview; img.hidden = false; } else { img.hidden = true; }
    var chips = $('#live-chips');
    chips.textContent = '';
    if (o.candidates && o.candidates.length) {
      o.candidates.forEach(function (c) { chips.appendChild(h('span', { class: 'chip' }, c.name, h('small', { text: c.frames + 'x' }))); });
    } else {
      chips.appendChild(h('span', { class: 'muted small', text: o.status === 'running' ? 'No repeating names yet.' : '' }));
    }
    $('#live-text').textContent = o.lastText || '';
  }

  /* ------------------------------------------------------------ incidents */
  function clipRow(m) {
    var rows = [];
    if (m.video) {
      rows.push(h('div', { class: 'cliprow ok' }, 'Recording saved: ', h('b', { text: m.video.file }), m.video.durationSec ? ' (' + m.video.durationSec + ' seconds, starts when you pressed the key)' : ''));
    } else if (m.recording && !m.recordError) {
      rows.push(h('div', { class: 'cliprow wait', text: 'Recording... press your key again to stop.' }));
    }
    if (m.recordError) rows.push(h('div', { class: 'cliprow miss', text: 'Recording problem: ' + m.recordError }));
    if (m.clip) {
      if (m.clip.manual || m.clip.windowStartSec == null) {
        rows.push(h('div', { class: 'cliprow ok' }, 'Clip chosen: ', h('b', { text: m.clip.file })));
      } else {
        rows.push(h('div', { class: 'cliprow ok' }, 'Clip linked: ', h('b', { text: m.clip.file }),
          ' - look between ', fmtClock(m.clip.windowStartSec), ' and ', fmtClock(m.clip.windowEndSec),
          m.clip.durationKnown ? '' : ' (estimated from your replay length)'));
      }
    } else if (!m.video && !m.watching) {
      if (Date.now() - m.t < 150000) rows.push(h('div', { class: 'cliprow wait', text: 'Waiting for the replay file to finish saving...' }));
      else rows.push(h('div', { class: 'cliprow miss', text: 'No clip found for this moment. Turn on recording in Settings, or check that Save Replay uses the same key and the clips folder is right. You can also choose a file yourself from the Report tab.' }));
    }
    return h('div', { class: 'cliprows' }, rows);
  }

  function markCard(m) {
    var head = h('div', { class: 'head' },
      h('span', { class: 'time', text: fmtTime(m.t) }),
      h('span', { class: 'muted small', text: fmtDay(m.t) }),
      h('span', { class: 'badge', text: m.game }),
      m.reportId ? h('span', { class: 'badge ok', text: 'Reported' }) : null,
      m.watching ? h('span', { class: 'badge warn', text: 'Reading names - press your key again to stop' }) : null,
      m.source === 'manual' ? h('span', { class: 'badge', text: 'test' }) : null);

    var names = (m.candidates || []).map(function (c) { return c.name; });
    if (m.suspect && names.indexOf(m.suspect) < 0) names.unshift(m.suspect);
    var chips = h('div', { class: 'chips' });
    var ign = (S.settings.ignoreNames || []).map(function (x) { return String(x).toLowerCase(); });
    names = names.filter(function (n) { return n === m.suspect || ign.indexOf(String(n).toLowerCase()) < 0; });
    names.forEach(function (n) {
      chips.appendChild(h('button', {
        type: 'button', class: 'chip' + (m.suspect === n ? ' on' : ''),
        onclick: function () { rk.updateMark(m.id, { suspect: m.suspect === n ? '' : n }); }
      }, n));
      chips.appendChild(h('button', {
        type: 'button', class: 'chip-x', title: 'Not a name. Stop suggesting "' + n + '".', 'aria-label': 'Not a name: ' + n,
        onclick: function () { rk.updateSettings({ ignoreNames: (S.settings.ignoreNames || []).concat([n]) }); }
      }, '\u00d7'));
    });
    var hint = null;
    if (!names.length) {
      hint = h('span', { class: 'muted small', text: m.watching ? 'Reading the screen now. Press your key again when you are done.'
        : S.settings.ocr.enabled ? (S.settings.ocr.mode === 'always' ? 'No names were on screen in the 45 seconds before this.' : 'No names were picked out while reading. You can type one in.')
        : 'Turn on screen reading in Settings to get name suggestions.' });
    }
    var input = h('input', {
      type: 'text', placeholder: 'Type a name', value: m.suspect || '', 'aria-label': 'Suspect name',
      onchange: function (e) { rk.updateMark(m.id, { suspect: e.target.value.trim() }); }
    });

    var btns = h('div', { class: 'btns' },
      h('button', { type: 'button', class: 'primary', onclick: function () { startDraft(m); } }, m.reportId ? 'Edit report' : 'Make report'),
      m.clip ? h('button', { type: 'button', class: 'ghost', onclick: function () { rk.showFile(m.clip.path); } }, 'Show clip') : null,
      m.video ? h('button', { type: 'button', class: 'ghost', onclick: function () { rk.showFile(m.video.path); } }, 'Show recording') : null,
      m.screenshot ? h('button', { type: 'button', class: 'ghost', onclick: function () { rk.showFile(m.screenshot); } }, 'Show screenshot') : null,
      h('button', { type: 'button', class: 'ghost', onclick: function () { rk.deleteMark(m.id); } }, 'Delete'));

    return h('div', { class: 'card' }, head, clipRow(m),
      h('div', { class: 'suspect' }, h('div', { class: 'lbl', text: 'Who was it?' }), chips, hint, input), btns);
  }

  function renderIncidents() {
    var list = $('#incidents-list');
    var a = document.activeElement;
    if (a && a.tagName === 'INPUT' && list.contains(a)) { pendingIncRender = true; return; }
    pendingIncRender = false;
    list.textContent = '';
    $('#incidents-empty').textContent = S.marks.length ? '' : 'No incidents yet. Press your hotkey in game, or use "Mark incident now" to try it.';
    S.marks.forEach(function (m) { list.appendChild(markCard(m)); });
    var hk = S.status.hotkey;
    $('#inc-sub').textContent = (hk.bound ? 'Press ' + hk.label + ' in game' : 'Set your hotkey in Settings, then press it in game') +
      '. Rap Sheet stamps the moment, links your replay clip, and lists the names it saw on screen' + (S.settings.ocr.enabled && S.settings.ocr.mode !== 'always' ? ' (press again to stop reading).' : '.');
  }

  /* ------------------------------------------------------------ report tab */
  function newDraft(mark) {
    var rep = mark && mark.reportId ? S.reports.filter(function (r) { return r.id === mark.reportId; })[0] : null;
    if (rep) {
      draft = { reportId: rep.id, markId: mark.id, game: rep.game, t: rep.t, server: rep.server, player: rep.player,
        behaviors: (rep.behaviors || []).slice(), desc: rep.desc, witnesses: rep.witnesses };
    } else {
      draft = { reportId: null, markId: mark ? mark.id : null, game: mark ? mark.game : S.settings.game, t: mark ? mark.t : Date.now(),
        server: mark ? mark.server || '' : '', player: mark ? mark.suspect || '' : '', behaviors: [], desc: '', witnesses: '' };
    }
    fillForm();
  }

  function startDraft(mark) { newDraft(mark); setTab('report'); }

  function fillForm() {
    $('#rp-game').value = draft.game;
    draftWhen = toLocalInput(draft.t);
    $('#rp-when').value = draftWhen;
    $('#rp-server').value = draft.server || '';
    $('#rp-player').value = draft.player || '';
    $('#rp-desc').value = draft.desc || '';
    $('#rp-wit').value = draft.witnesses || '';
    Array.prototype.forEach.call(document.querySelectorAll('#rp-behaviors input'), function (c) { c.checked = draft.behaviors.indexOf(c.value) >= 0; });
    schedulePreview();
  }

  function readForm() {
    draft.game = $('#rp-game').value;
    var w = $('#rp-when').value;
    if (w && w !== draftWhen) {
      var t = new Date(w).getTime();
      if (!isNaN(t)) { draft.t = t; draftWhen = w; }
    }
    draft.server = $('#rp-server').value.trim();
    draft.player = $('#rp-player').value.trim();
    draft.desc = $('#rp-desc').value.trim();
    draft.witnesses = $('#rp-wit').value.trim();
    draft.behaviors = Array.prototype.map.call(document.querySelectorAll('#rp-behaviors input:checked'), function (c) { return c.value; });
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      if (!draft) return;
      var seq = ++previewSeq;
      rk.buildReport(draft).then(function (r) {
        if (seq !== previewSeq || !r || !r.ok) return;
        $('#rp-out').value = r.text;
        var hist = $('#rp-history');
        if (r.history && r.history.count > 0) {
          hist.hidden = false;
          hist.textContent = 'You have reported this player ' + r.history.count + ' time' + (r.history.count === 1 ? '' : 's') +
            ' before (first ' + fmtDay(r.history.firstT) + ', most recent ' + fmtDay(r.history.lastT) + '). That is included in the report text.';
        } else { hist.hidden = true; }
        var ev = $('#rp-evidence');
        ev.textContent = '';
        var mid = draft.markId;
        function evRow(label, file, p, kind) {
          var row = h('div', { class: 'rowline' }, h('span', { class: file ? 'okline' : 'muted', text: label }));
          if (file) {
            row.appendChild(h('span', { class: 'evfile', text: file }));
            row.appendChild(h('span', { class: 'dragchip', draggable: 'true', title: 'Drag this into Discord or a website upload box',
              ondragstart: function (e) { e.preventDefault(); rk.dragFile(p); } }, 'Drag out'));
            row.appendChild(h('button', { type: 'button', class: 'ghost small', onclick: function () { rk.showFile(p); } }, 'Show in folder'));
          } else {
            row.appendChild(h('span', { class: 'muted', text: 'none yet' }));
          }
          if (kind && mid) {
            row.appendChild(h('button', { type: 'button', class: 'ghost small', onclick: function () {
              rk.attach(mid, kind).then(function (res) { if (res && res.ok) schedulePreview(); });
            } }, file ? 'Choose a different file...' : 'Choose file...'));
          }
          ev.appendChild(row);
        }
        if (!mid) {
          ev.appendChild(h('div', { class: 'rowline muted', text: 'No incident is linked, so no clip or screenshot. Make a report from the Incidents tab to include them.' }));
        } else {
          evRow('Clip', r.clip && r.clip.file, r.clip && r.clip.path, 'clip');
          if (r.video) evRow('Recording', r.video.file, r.video.path, null);
          evRow('Screenshot', r.screenshot ? r.screenshot.split(/[\\/]/).pop() : '', r.screenshot, 'screenshot');
        }
        $('#rp-route').textContent = 'Where to send it: ' + r.route;
      });
    }, 120);
  }

  function initReport() {
    var gsel = $('#rp-game');
    var wrap = $('#rp-behaviors');
    BEHAVIORS.forEach(function (b, i) {
      wrap.appendChild(h('label', { class: 'chip' }, h('input', { type: 'checkbox', value: b[0], id: 'beh' + i }), b[1]));
    });
    var form = $('#rp-form');
    form.addEventListener('submit', function (e) { e.preventDefault(); });
    var onEdit = function () { if (!draft) return; readForm(); schedulePreview(); };
    form.addEventListener('input', onEdit);
    form.addEventListener('change', onEdit);
    $('#rp-copy').addEventListener('click', function (e) {
      rk.copy($('#rp-out').value).then(function () { flash(e.currentTarget, 'Copied'); });
    });
    $('#rp-save').addEventListener('click', function (e) {
      var btn = e.currentTarget;
      readForm();
      rk.saveReport(draft).then(function (r) {
        if (r && r.ok) { draft.reportId = r.id; flash(btn, 'Saved'); }
      });
    });
    $('#rp-new').addEventListener('click', function () { newDraft(null); });
    return gsel;
  }

  /* ------------------------------------------------------------ repeat offenders */
  function groupSummary(g) {
    var reps = S.reports.filter(function (r) { return g.reportIds.indexOf(r.id) >= 0; }).sort(function (a, b) { return a.t - b.t; });
    var lines = [
      'REPEAT OFFENDER SUMMARY - ' + g.name,
      'Reported ' + g.count + ' times by me across ' + g.days + ' day' + (g.days === 1 ? '' : 's') + ' (' + fmtDay(g.firstT) + ' to ' + fmtDay(g.lastT) + ').'
    ];
    if (g.aliases.length) lines.push('Also seen as: ' + g.aliases.join(', '));
    if (g.games.length) lines.push('Games: ' + g.games.join(', '));
    if (g.servers.length) lines.push('Servers: ' + g.servers.join(', '));
    lines.push('', 'Reports:');
    reps.forEach(function (r) {
      var d = (r.desc || '').replace(/\s+/g, ' ');
      lines.push('- ' + fmtDT(r.t) + ' | ' + r.game + (r.server ? ' | ' + r.server : '') + (r.clipFile ? ' | clip: ' + r.clipFile : '') + (d ? ' | ' + d.slice(0, 160) : ''));
    });
    return lines.join('\n');
  }

  function groupCard(g) {
    var reps = S.reports.filter(function (r) { return g.reportIds.indexOf(r.id) >= 0; }).sort(function (a, b) { return b.t - a.t; });
    var copyBtn = h('button', { type: 'button', class: 'ghost small', 'data-label': 'Copy summary',
      onclick: function (e) { rk.copy(groupSummary(g)).then(function () { flash(e.currentTarget, 'Copied'); }); } }, 'Copy summary');
    return h('div', { class: 'card group' },
      h('div', { class: 'head' }, h('b', { text: g.name }), h('span', { class: 'badge' + (g.count >= 2 ? ' warn' : ''), text: g.count + (g.count === 1 ? ' report' : ' reports') }),
        g.aliases.length ? h('span', { class: 'muted small', text: 'also seen as ' + g.aliases.join(', ') }) : null),
      h('div', { class: 'stats' },
        h('span', null, h('b', { text: g.days }), ' day' + (g.days === 1 ? '' : 's')),
        h('span', null, 'first ', h('b', { text: fmtDay(g.firstT) })),
        h('span', null, 'last ', h('b', { text: fmtDay(g.lastT) })),
        g.games.length ? h('span', { text: g.games.join(', ') }) : null,
        g.servers.length ? h('span', { text: g.servers.length + ' server' + (g.servers.length === 1 ? '' : 's') }) : null),
      h('details', null, h('summary', { text: 'Show reports' }),
        h('ul', null, reps.map(function (r) {
          return h('li', null, fmtDT(r.t) + ' - ' + r.game + (r.server ? ' - ' + r.server : '') + (r.clipFile ? ' - clip ' + r.clipFile : '') + ' ',
            h('button', { type: 'button', class: 'ghost small', onclick: function () { rk.deleteReport(r.id); } }, 'Delete'));
        }))),
      h('div', { class: 'btns' }, copyBtn));
  }

  function renderOffenders() {
    var list = $('#off-list');
    var open = {};
    Array.prototype.forEach.call(list.querySelectorAll('.group'), function (el, i) { if (el.querySelector('details').open) open[i] = true; });
    list.textContent = '';
    $('#off-empty').textContent = S.groups.length ? '' : 'Nothing here yet. Save a report with a player name and it will be tracked.';
    S.groups.forEach(function (g, i) {
      var c = groupCard(g);
      if (open[i]) c.querySelector('details').open = true;
      list.appendChild(c);
    });
  }

  /* ------------------------------------------------------------ settings */
  function setVal(el, v) { if (document.activeElement !== el) el.value = v; }

  function syncSettings() {
    var s = S.settings, hk = S.status.hotkey, w = S.status.watcher;
    $('#st-hotkey').textContent = hk.bound ? hk.label : 'not set';
    $('#st-hook').checked = hk.mode === 'hook';
    $('#st-hotkey-btn').textContent = hk.mode === 'hook' && !hk.bound ? 'Capture key' : 'Change key';
    if (hk.bound && !hk.started) $('#st-hotkey-msg').textContent = hk.mode === 'hook' ? 'The key listener could not start' + (hk.error ? ': ' + hk.error : '.') : (hk.error || 'The key could not be registered.');
    setVal($('#st-fallback'), s.fallbackHotkey || '');
    $('#st-fallback-msg').textContent = !s.fallbackHotkey ? 'off' : hk.fallbackOk ? 'working' : 'could not register (another app may be using it)';
    setVal($('#st-dir'), s.recordingDir || '');
    var msg = $('#st-dir-msg');
    msg.className = 'small ' + (w.ok ? 'okline' : 'warnline');
    msg.textContent = w.ok ? 'Watching this folder. ' + w.recent + ' clip' + (w.recent === 1 ? '' : 's') + ' seen since Rap Sheet started.' : (w.error || 'No folder chosen yet.');
    setVal($('#st-replaylen'), s.replayLenSec);
    $('#st-ocr-on').checked = !!s.ocr.enabled;
    $('#st-region-sum').textContent = !s.ocr.region ? 'No area chosen yet'
      : s.ocr.region.rel ? 'Area: ' + Math.round(s.ocr.region.fw * 100) + '% x ' + Math.round(s.ocr.region.fh * 100) + '% of the game window'
      : 'Area: ' + s.ocr.region.width + ' x ' + s.ocr.region.height + ' px at (' + s.ocr.region.x + ', ' + s.ocr.region.y + ')';
    fillWindowSelect($('#st-window'), $('#st-window-msg'));
    $('#st-region').textContent = s.ocr.region ? 'Move / resize area' : 'Select area';
    setVal($('#st-interval'), String(s.ocr.intervalMs));
    setVal($('#st-ocr-mode'), s.ocr.mode === 'always' ? 'always' : 'press');
    var rc = s.record || {};
    $('#st-rec-on').checked = !!rc.enabled;
    setVal($('#st-rec-quality'), rc.quality === '1080' ? '1080' : '720');
    setVal($('#st-rec-encoder'), rc.encoder || 'auto');
    setVal($('#st-rec-source'), rc.source === 'window' ? 'window' : 'screen');
    $('#st-rec-display-row').hidden = rc.source === 'window';
    $('#st-rec-source-help').textContent = rc.source === 'window'
      ? 'Only the game window is captured, so Discord, overlays and other apps never appear. Windows only lets apps capture a single window at about 15 frames per second, so the video will look choppy.'
      : 'Records everything shown on that display at 30 frames per second, including overlays and notifications that appear on top of the game. Automatic uses the display your mouse is on when you press the key.';
    rk.displays().then(function (r) {
      var sel = $('#st-rec-display'); if (!sel || !r || !r.displays) return;
      sel.textContent = '';
      sel.appendChild(h('option', { value: 'auto', text: 'Automatic (where the mouse is)' }));
      r.displays.forEach(function (d) { sel.appendChild(h('option', { value: d.id, text: d.label })); });
      sel.value = rc.display || 'auto';
    });
    $('#st-rec-dir').value = rc.dir || '(default: Rap Sheet data folder > recordings)';
    $('#st-rec-msg').textContent = !rc.enabled ? 'Recording is off.'
      : rc.source === 'window' && !s.ocr.gameWindow ? 'Choose your game window under Screen reading first.'
      : 'Ready. Press your incident key in game to start, and again to stop. It also stops by itself after ' + (s.ocr.maxWatchSec || 120) + ' seconds.';
    $('#st-ocr-mode-help').textContent = s.ocr.mode === 'always'
      ? 'Reads your screen every few seconds while you play. Names from before your key press are kept, but it costs CPU the whole time.'
      : 'Press your key once to mark the incident and start reading names. Press it again to stop. Nothing runs in between, and it stops by itself after ' + (s.ocr.maxWatchSec || 120) + ' seconds.';
    setVal($('#st-ignore'), (s.ignoreNames || []).join('\n'));
    $('#st-shot').checked = !!s.saveScreenshot;
    $('#st-login').checked = !!s.startWithWindows;
    $('#st-tray').checked = !!s.minimizeToTray;
    setVal($('#st-game'), s.game);
    if (document.activeElement !== $('#st-gamename')) $('#st-gamename').value = s.gameName || '';
    var u = S.update || { status: 'disabled' };
    var utxt = { disabled: 'Updates: not available' + (u.reason ? ' (' + u.reason + ')' : ''), idle: 'Updates: checking soon', checking: 'Updates: checking...', uptodate: 'Updates: you have the latest version', downloading: 'Updates: downloading ' + (u.version || '') + ' (' + (u.percent || 0) + '%)', ready: 'Updates: ' + (u.version || 'new version') + ' is ready. It installs when you close Rap Sheet, or restart now.', error: 'Updates: could not check (' + (u.error || 'unknown error') + ')' }[u.status] || 'Updates: unknown';
    $('#st-update').textContent = utxt;
    $('#st-update-check').disabled = u.status === 'disabled' || u.status === 'checking' || u.status === 'downloading' || u.status === 'ready';
    $('#st-update-install').hidden = u.status !== 'ready';
    $('#st-about').textContent = 'Rap Sheet ' + S.version + '. Your data stays on this PC in ' + S.dataDir;
  }

  function fillGameSelects() {
    ['#rp-game', '#st-game'].forEach(function (sel) {
      var el = $(sel);
      el.textContent = '';
      S.games.forEach(function (g) { el.appendChild(h('option', { value: g, text: g })); });
    });
  }

  function showOcrTest(r, targetPrefix) {
    var box = $(targetPrefix + '-result');
    box.hidden = false;
    var img = $(targetPrefix + '-img');
    if (r && r.preview) { img.src = r.preview; img.hidden = false; } else { img.hidden = true; }
    var txt = $(targetPrefix + '-text');
    var names = $(targetPrefix + '-names');
    names.textContent = '';
    if (r && r.ok) {
      txt.textContent = r.text ? r.text : '(no text was found in that area)';
      (r.candidates || []).forEach(function (n) { names.appendChild(h('span', { class: 'chip' }, n)); });
      if (!(r.candidates || []).length) names.appendChild(h('span', { class: 'muted small', text: 'No names picked out. Try a tighter area around just the names, or a clearer part of the screen.' }));
    } else {
      txt.textContent = (r && (r.reason || r.error)) || 'Could not read the screen.';
    }
  }

  function initSettings() {
    var on = function (sel, ev, fn) { $(sel).addEventListener(ev, fn); };
    on('#st-hotkey-btn', 'click', function () {
      var b = $('#st-hotkey-btn');
      b.disabled = true; b.textContent = 'Press the key now...';
      $('#st-hotkey-msg').textContent = '';
      pickKey().then(function (r) {
        b.disabled = false; b.textContent = 'Change key';
        $('#st-hotkey-msg').textContent = r && r.ok ? 'Saved.' : (r && r.error) || 'Could not read a key.';
      });
    });
    on('#st-update-check', 'click', function () { rk.checkUpdate(); });
    on('#st-update-install', 'click', function () { rk.installUpdate(); });
    on('#st-hook', 'change', function (e) { rk.updateSettings({ hotkeyMode: e.target.checked ? 'hook' : 'safe' }); });
    on('#st-fallback', 'change', function (e) { rk.updateSettings({ fallbackHotkey: e.target.value.trim() }); });
    on('#st-dir-choose', 'click', function () {
      rk.chooseFolder().then(function (r) { if (r && r.ok) rk.updateSettings({ recordingDir: r.dir }); });
    });
    on('#st-dir-detect', 'click', function () {
      rk.detectFolder().then(function (r) { if (r && r.dir) rk.updateSettings({ recordingDir: r.dir }); });
    });
    on('#st-replaylen', 'change', function (e) { rk.updateSettings({ replayLenSec: Number(e.target.value) }); });
    on('#st-window', 'change', function (e) { rk.updateSettings({ ocr: { gameWindow: e.target.value, region: null } }); });
    on('#st-window-refresh', 'click', function () { fillWindowSelect($('#st-window'), $('#st-window-msg')); });
    on('#st-ocr-on', 'change', function (e) {
      if (e.target.checked && !S.settings.ocr.region) {
        e.target.checked = false;
        $('#st-region-sum').textContent = 'Choose the game window and an area first, then turn this on.';
        return;
      }
      rk.updateSettings({ ocr: { enabled: e.target.checked } });
    });
    on('#st-region', 'click', function () {
      var b = $('#st-region');
      b.disabled = true;
      $('#st-region-sum').textContent = 'Opening the editor...';
      rk.pickRegion().then(function (r) {
        b.disabled = false;
        if (r && r.ok) rk.updateSettings({ ocr: { enabled: true } });
        else $('#st-region-sum').textContent = (r && r.error) || 'No area selected.';
      });
    });
    on('#st-rec-on', 'change', function (e) { rk.updateSettings({ record: { enabled: e.target.checked } }); });
    on('#st-rec-quality', 'change', function (e) { rk.updateSettings({ record: { quality: e.target.value } }); });
    on('#st-rec-source', 'change', function (e) { rk.updateSettings({ record: { source: e.target.value } }); });
    on('#st-rec-display', 'change', function (e) { rk.updateSettings({ record: { display: e.target.value } }); });
    on('#st-rec-encoder', 'change', function (e) { rk.updateSettings({ record: { encoder: e.target.value, lastMime: '' } }); });
    on('#st-rec-choose', 'click', function () { rk.chooseRecordDir(); });
    on('#st-rec-open', 'click', function () { rk.openRecordDir(); });
    on('#st-ocr-mode', 'change', function (e) { rk.updateSettings({ ocr: { mode: e.target.value } }); });
    on('#st-interval', 'change', function (e) { rk.updateSettings({ ocr: { intervalMs: Number(e.target.value) } }); });
    on('#st-ocr-test', 'click', function () {
      var b = $('#st-ocr-test');
      b.disabled = true; b.textContent = 'Reading...';
      rk.testOcr().then(function (r) { b.disabled = false; b.textContent = 'Test reading now'; showOcrTest(r, '#st-ocr'); });
    });
    on('#st-ignore', 'change', function (e) { rk.updateSettings({ ignoreNames: e.target.value }); });
    on('#st-shot', 'change', function (e) { rk.updateSettings({ saveScreenshot: e.target.checked }); });
    on('#st-login', 'change', function (e) { rk.updateSettings({ startWithWindows: e.target.checked }); });
    on('#st-tray', 'change', function (e) { rk.updateSettings({ minimizeToTray: e.target.checked }); });
    on('#st-game', 'change', function (e) { rk.updateSettings({ game: e.target.value }); });
    on('#st-gamename', 'change', function (e) { rk.updateSettings({ gameName: e.target.value }); });
    on('#st-copy-fb', 'click', function (e) {
      var b = e.currentTarget;
      rk.recentLog().then(function (t) {
        var tpl = 'RAP SHEET BETA FEEDBACK\n\nGame tested:\nWhat I did (window mode / fullscreen, recording on/off, reading on/off):\nDid the hotkey work every time?\nDid names get read correctly? (kill feed / nameplates / chat; where on screen):\nDid the game stutter or did anti-cheat complain?\nOther problems or ideas:\n\n--- diagnostics ---\n' + (typeof t === 'string' ? t : '');
        return rk.copy(tpl);
      }).then(function () { flash(b, 'Copied'); });
    });
    on('#st-open-data', 'click', function () { rk.openData(); });
    on('#st-open-log', 'click', function () { rk.openLog(); });
    on('#st-copy-log', 'click', function (e) {
      var b = e.currentTarget;
      rk.recentLog().then(function (t) { return rk.copy(typeof t === 'string' ? t : ''); }).then(function () { flash(b, 'Copied'); });
    });
    var clearTimer = null;
    on('#st-clear', 'click', function (e) {
      var b = e.currentTarget;
      if (b.getAttribute('data-armed') === '1') {
        clearTimeout(clearTimer);
        b.removeAttribute('data-armed');
        b.textContent = b.getAttribute('data-label');
        rk.clearMarks();
        return;
      }
      b.setAttribute('data-armed', '1');
      b.textContent = 'Click again to confirm';
      clearTimer = setTimeout(function () { b.removeAttribute('data-armed'); b.textContent = b.getAttribute('data-label'); }, 4000);
    });
  }

  /* ------------------------------------------------------------ first-run wizard */
  var WIZ_STEPS = 5;

  function wizFoot(card, o) {
    var back = o.back ? h('button', { type: 'button', class: 'ghost', onclick: o.back }, 'Back') : h('span');
    var next = h('button', { type: 'button', class: 'primary', disabled: !!o.nextDisabled, onclick: o.next }, o.nextLabel || 'Next');
    card.appendChild(h('div', { class: 'wiz-foot' }, back, next));
  }

  function goStep(n) {
    wizStep = n;
    wizMsg = '';
    wizResult = null;
    if (n === 1 && !S.settings.recordingDir) {
      rk.detectFolder().then(function (r) { if (r && r.dir) rk.updateSettings({ recordingDir: r.dir }); });
    }
    if (n === 2) wizMarkBase = S.marks.length;
    renderWizard();
  }

  var WIZ = [
    function (card) {
      card.appendChild(h('h1', { text: 'Welcome to Rap Sheet' }));
      card.appendChild(h('p', { text: 'Two minutes to set up. After that, when you spot a cheater you press your Save Replay key and Rap Sheet does the rest:' }));
      card.appendChild(h('ul', { class: 'plain' },
        h('li', { text: 'stamps the exact moment and saves a screenshot' }),
        h('li', { text: 'links your replay clip and tells you where in it to look' }),
        h('li', { text: 'suggests the player\'s name from what was on screen' }),
        h('li', { text: 'writes the report text and tracks repeat offenders' })));
      card.appendChild(h('div', { class: 'banner' }, 'Rap Sheet never touches your game. It reads the screen the way OBS does, listens for one key, and sends no keystrokes or clicks. Everything stays on this PC.'));
      wizFoot(card, { next: function () { goStep(1); } });
    },
    function (card) {
      var w = S.status.watcher;
      card.appendChild(h('h1', { text: 'Where do your clips save?' }));
      card.appendChild(h('p', { text: 'In Streamlabs, turn on the replay buffer (Settings > Output > Replay Buffer) and note your Recording Path. Rap Sheet watches that folder.' }));
      card.appendChild(h('div', { class: 'row' }, h('input', { type: 'text', readonly: true, value: S.settings.recordingDir || '', placeholder: 'No folder yet' })));
      card.appendChild(h('div', { class: 'btns' },
        h('button', { type: 'button', class: 'ghost', onclick: function () { rk.chooseFolder().then(function (r) { if (r && r.ok) rk.updateSettings({ recordingDir: r.dir }); }); } }, 'Choose folder'),
        h('button', { type: 'button', class: 'ghost', onclick: function () { rk.detectFolder().then(function (r) { if (r && r.dir) rk.updateSettings({ recordingDir: r.dir }); }); } }, 'Auto-detect')));
      card.appendChild(h('p', { class: w.ok ? 'okline' : 'warnline', text: w.ok ? 'Watching this folder.' : (w.error || 'Pick the folder where replays are saved.') }));
      wizFoot(card, { back: function () { goStep(0); }, next: function () { goStep(2); }, nextDisabled: !S.settings.recordingDir });
    },
    function (card) {
      var hk = S.status.hotkey;
      var detected = S.marks.length > wizMarkBase;
      card.appendChild(h('h1', { text: 'Pick your incident key' }));
      card.appendChild(h('p', { text: 'Pick the key you will press in game to start and stop an incident. F5 is the default and is not used by most games. Press Change key, then press the key you want. If you use Streamlabs or OBS replay buffer, you can set its Save Replay key to the same one.' }));
      card.appendChild(h('div', { class: 'row' },
        h('span', { class: 'mono key', text: hk.bound ? hk.label : 'not set' }),
        h('button', { type: 'button', class: 'ghost', onclick: function (e) {
          var b = e.currentTarget; b.disabled = true; b.textContent = 'Press the key now...';
          pickKey().then(function (r) { wizMsg = r && r.ok ? '' : (r && r.error) || 'Could not read a key.'; wizMarkBase = S.marks.length; renderWizard(); });
        } }, hk.bound ? 'Change key' : 'Choose key')));
      if (wizMsg) card.appendChild(h('p', { class: 'warnline', text: wizMsg }));
      if (hk.bound) {
        card.appendChild(h('p', { class: detected ? 'okline' : 'muted', text: detected ? 'Key detected. An incident was marked, so this works.' : 'Now test it: press that key once. A green confirmation will appear here.' }));
      }
      if (hk.bound && !hk.started) card.appendChild(h('p', { class: 'warnline', text: (hk.mode === 'hook' ? 'The key listener could not start' : 'That key could not be registered') + (hk.error ? ': ' + hk.error : '.') + ' The backup key (' + hk.fallbackLabel + ') still works.' }));
      wizFoot(card, { back: function () { goStep(1); }, next: function () { goStep(3); }, nextDisabled: !hk.bound });
    },
    function (card) {
      var o = S.settings.ocr;
      card.appendChild(h('h1', { text: 'Name suggestions (optional)' }));
      card.appendChild(h('p', { text: 'Rap Sheet can read one small part of your screen, like the kill feed, and suggest the name of whoever keeps showing up. By default it only reads between two presses of your key (press once when you see the cheater, again when you are done), so it uses no resources the rest of the time. It reads only your game window, never the rest of your desktop. Start your game in borderless windowed mode, choose its window below, then press Select area.' }));
      var wsel = h('select', { id: 'wiz-window', onchange: function (e) { rk.updateSettings({ ocr: { gameWindow: e.target.value, region: null } }); } });
      card.appendChild(h('div', { class: 'row' }, h('span', { class: 'muted small', text: 'Game window' }), wsel,
        h('button', { type: 'button', class: 'ghost', onclick: function () { fillWindowSelect(wsel, null); } }, 'Refresh list')));
      fillWindowSelect(wsel, null);
      card.appendChild(h('div', { class: 'btns' },
        h('button', { type: 'button', class: 'ghost', onclick: function (e) {
          var b = e.currentTarget; b.disabled = true; wizMsg = 'Opening the picker...'; renderWizard();
          rk.pickRegion().then(function (r) {
            if (r && r.ok) {
              wizMsg = 'Area saved. Testing it...';
              rk.updateSettings({ ocr: { enabled: true } }).then(function () { return rk.testOcr(); }).then(function (t) { wizResult = t; wizMsg = ''; renderWizard(); });
            } else { wizMsg = (r && r.error) || 'No area selected.'; renderWizard(); }
          });
        } }, o.region ? 'Select a different area' : 'Select area'),
        o.region ? h('button', { type: 'button', class: 'ghost', onclick: function () { rk.testOcr().then(function (t) { wizResult = t; renderWizard(); }); } }, 'Test reading') : null));
      if (wizMsg) card.appendChild(h('p', { class: 'muted', text: wizMsg }));
      if (o.region) card.appendChild(h('p', { class: 'okline', text: 'Area chosen: ' + o.region.width + ' x ' + o.region.height + ' px.' }));
      if (wizResult) {
        var res = h('div', { class: 'test-result' });
        if (wizResult.preview) res.appendChild(h('img', { src: wizResult.preview, alt: 'Captured area' }));
        res.appendChild(h('div', null,
          h('pre', { class: 'mono small', text: wizResult.ok ? (wizResult.text || '(no text found in that area)') : (wizResult.reason || wizResult.error || 'Could not read the screen.') }),
          h('div', { class: 'chips' }, (wizResult.candidates || []).map(function (n) { return h('span', { class: 'chip', text: n }); }))));
        card.appendChild(res);
      }
      wizFoot(card, { back: function () { goStep(2); }, next: function () { goStep(4); }, nextLabel: o.region ? 'Next' : 'Skip for now' });
    },
    function (card) {
      var s = S.settings, hk = S.status.hotkey, w = S.status.watcher;
      card.appendChild(h('h1', { text: 'You are set' }));
      card.appendChild(h('ul', { class: 'plain' },
        h('li', { text: 'Incident key: ' + (hk.bound ? hk.label : 'not set') }),
        h('li', { text: 'Clips folder: ' + (w.ok ? s.recordingDir : 'not set') }),
        h('li', { text: 'Name suggestions: ' + (s.ocr.enabled && s.ocr.region ? 'on' : 'off') })));
      card.appendChild(h('p', { text: 'Leave Rap Sheet running in the tray while you play. When you see a cheater, press your key; if name reading is on, press it again when you are done. Then open the Incidents tab, tap the right name, and press Make report.' }));
      wizFoot(card, { back: function () { goStep(3); }, nextLabel: 'Finish', next: function () { rk.updateSettings({ firstRunDone: true }).then(function () { setTab('help'); }); } });
    }
  ];

  function renderWizard() {
    var w = $('#wizard');
    if (!S || S.settings.firstRunDone) { w.hidden = true; return; }
    w.hidden = false;
    w.textContent = '';
    var card = h('div', { class: 'wiz-card' });
    var dots = h('div', { class: 'dots' });
    for (var i = 0; i < WIZ_STEPS; i++) dots.appendChild(h('i', { class: i <= wizStep ? 'on' : '' }));
    card.appendChild(dots);
    WIZ[wizStep](card);
    w.appendChild(card);
  }

  /* ------------------------------------------------------------ wiring */
  function onState(st) {
    var first = !S;
    S = st;
    if (first) { fillGameSelects(); }
    renderPills();
    renderLive();
    renderIncidents();
    renderOffenders();
    syncSettings();
    renderWizard();
    if (draft && tab === 'report') schedulePreview();
  }

  function onOcr(o) {
    OCR = o;
    if (!S) return;
    renderPills();
    renderLive();
  }

  function init() {
    initReport();
    initSettings();
    $('#tabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-tab]');
      if (b) setTab(b.getAttribute('data-tab'));
    });
    $('#btn-mark').addEventListener('click', function () { rk.markNow(); });
    $('#incidents-list').addEventListener('focusout', function () { if (pendingIncRender) setTimeout(function () { if (S) renderIncidents(); }, 0); });
    rk.on('state', onState);
    rk.on('ocr', onOcr);
    rk.on('navigate', function (p) { if (p && p.tab) setTab(p.tab); });
    rk.state().then(onState);
  }

  init();
})();
