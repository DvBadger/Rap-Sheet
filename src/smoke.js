'use strict';
// Self-test harness. Only runs when the app is started with RK_SMOKE=1 (never in normal use).
// It drives the real app: OCR loop, incident marks, clip linking, the UI and the report flow.
const fs = require('fs');
const os = require('os');
const path = require('path');

function box(type, payload) {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(8 + payload.length, 0);
  b.write(type, 4, 'latin1');
  payload.copy(b, 8);
  return b;
}
function fakeMp4(seconds) {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(seconds * 1000, 16);
  return Buffer.concat([box('ftyp', Buffer.from('isom0000isom', 'latin1')), box('mdat', Buffer.alloc(4000, 7)), box('moov', box('mvhd', mvhd))]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(ctx) {
  const out = { checks: {}, consoleErrors: [] };
  const check = (name, ok, detail) => { out.checks[name] = { ok: !!ok, detail: detail === undefined ? '' : detail }; };
  const win = ctx.win();
  const shotDir = process.env.RK_SHOT_DIR;
  const ex = (js) => win.webContents.executeJavaScript(js);
  const shot = async (name) => {
    if (!shotDir) return;
    try {
      fs.mkdirSync(shotDir, { recursive: true });
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(shotDir, name + '.png'), img.toPNG());
    } catch (e) { out.consoleErrors.push('shot ' + name + ': ' + e.message); }
  };
  const push = () => win.webContents.send('state', ctx.publicState());

  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) out.consoleErrors.push(message); });

  try {
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
    win.setSize(1100, 800);
    win.show();
    await sleep(1500);

    // ---- first-run wizard appears for a fresh profile
    check('wizard-shown-on-first-run', await ex("!document.getElementById('wizard').hidden"));
    await shot('01-wizard-welcome');

    // ---- configure like a user would
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-clips-'));
    ctx.store.updateSettings({
      recordingDir: dir, firstRunDone: true,
      hotkey: { keycode: 67, name: 'F9', ctrl: false, alt: false, shift: false, meta: false },
      ocr: { enabled: true, mode: 'always', region: { displayId: 0, x: 0, y: 0, width: 520, height: 170 }, intervalMs: 1000 },
      ignoreNames: ['BadgerOne'], record: { enabled: false }
    });
    ctx.watcher.start(dir);
    await ctx.ocr.start();
    check('ocr-started', ctx.ocr.status === 'running', ctx.ocr.error);
    await sleep(4500);
    push();

    const cands = ctx.ocr.candidates();
    check('ocr-finds-names', cands.length >= 2, cands.map((c) => c.name + ':' + c.frames).join(', '));
    check('ignore-list-hides-own-name', !cands.some((c) => /badger/i.test(c.name)), cands.map((c) => c.name).join(', '));

    // ---- incident mark, then the replay clip appears a moment later
    const mark = ctx.createMark('smoke');
    check('mark-carries-name-suggestions', mark.candidates.length >= 2, mark.candidates.map((c) => c.name).join(', '));
    await sleep(800);
    fs.writeFileSync(path.join(dir, 'Replay 2026-11-24 12-00-00.mp4'), fakeMp4(90));
    await sleep(4500);
    check('clip-linked-to-mark', !!mark.clip && mark.clip.file.startsWith('Replay') && mark.clip.durationKnown && mark.clip.offsetSec > 86 && mark.clip.offsetSec <= 90,
      mark.clip ? JSON.stringify(mark.clip) : 'no clip');
    push();
    await sleep(600);

    // ---- UI: incident card is rendered
    check('ui-incident-card', (await ex("document.querySelectorAll('#incidents-list .card').length")) === 1);
    check('ui-live-panel-visible', await ex("!document.getElementById('live').hidden"));
    check('ui-clip-row-text', /Clip linked: Replay/.test(await ex("document.querySelector('.cliprow').textContent")));
    await shot('02-incidents');

    // ---- UI: pick a suggested name, make a report
    await ex("document.querySelector('#incidents-list .chips .chip').click()");
    await sleep(500);
    await ex("Array.from(document.querySelectorAll('#incidents-list .btns button')).find(b => /report/i.test(b.textContent)).click()");
    await sleep(700);
    const player = await ex("document.getElementById('rp-player').value");
    check('ui-suspect-flows-into-report', player.length >= 3, player);
    await ex("document.getElementById('rp-desc').value='Tracked us through two walls.'; document.getElementById('rp-desc').dispatchEvent(new Event('input',{bubbles:true}))");
    await ex("document.querySelector('#rp-behaviors input').click()");
    await sleep(600);
    const text1 = await ex("document.getElementById('rp-out').value");
    check('report-has-clip-window', /look between 1:\d\d and 1:\d\d/.test(text1) || /look between 0:\d\d and 1:\d\d/.test(text1), text1.split('\n').filter((l) => /Clip|look/.test(l)).join(' | '));
    check('report-has-player-and-behavior', text1.includes(player) && /seeing through walls/.test(text1));
    await shot('03-report');
    await ex("document.getElementById('rp-save').click()");
    await sleep(500);
    check('report-saved', ctx.store.data.reports.length === 1);

    // ---- second incident, same player (OCR misread by one letter) -> repeat-offender tracking
    const mark2 = ctx.createMark('smoke');
    await sleep(300);
    ctx.store.data.marks[0].suspect = player.replace(/.$/, 'x');
    ctx.store.save();
    push();
    await sleep(500);
    await ex("document.querySelector('#incidents-list .card .btns .primary').click()");
    await sleep(800);
    const text2 = await ex("document.getElementById('rp-out').value");
    check('report-shows-history', /Previous reports of this player by me: 1/.test(text2), text2.split('\n').filter((l) => /Previous/.test(l)).join(' | '));
    check('ui-history-banner', await ex("!document.getElementById('rp-history').hidden"));
    await ex("document.getElementById('rp-save').click()");
    await sleep(500);
    await ex("document.querySelector('[data-tab=offenders]').click()");
    await sleep(500);
    check('offenders-groups-misread-names', ctx.store.data.reports.length === 2 && (await ex("document.querySelectorAll('#off-list .card').length")) === 1,
      'cards=' + (await ex("document.querySelectorAll('#off-list .card').length")));
    await shot('04-offenders');

    // ---- settings tab reflects state
    await ex("document.querySelector('[data-tab=settings]').click()");
    await sleep(400);
    check('settings-show-folder', (await ex("document.getElementById('st-dir').value")) === dir);
    check('settings-show-region', /520 x 170/.test(await ex("document.getElementById('st-region-sum').textContent")));
    await shot('05-settings');

    // ---- press-to-watch mode: no OCR until the key is pressed, stops on the second press
    ctx.store.updateSettings({ ocr: { mode: 'press' } });
    await ctx.ocr.stop();
    await sleep(500);
    check('press-mode-idle-before-press', ctx.ocr.status === 'off' && !ctx.ocr.worker && !ctx.ocr.timer, ctx.ocr.status);
    await sleep(1700);
    ctx.press();
    await sleep(200);
    const wm = ctx.store.data.marks[0];
    check('press-mode-first-press-marks-and-watches', wm.watching === true && wm.source === 'smoke' && ctx.ocr.running, JSON.stringify({ w: wm.watching, running: ctx.ocr.running }));
    await sleep(5500);
    push();
    check('press-mode-reads-while-watching', ctx.ocr.candidates().length >= 2, ctx.ocr.candidates().map((c) => c.name).join(','));
    await sleep(1700);
    ctx.press();
    await sleep(1500);
    const wm2 = ctx.store.data.marks[0];
    check('press-mode-second-press-keeps-names', wm2.id === wm.id && wm2.watching === false && wm2.candidates.length >= 2, JSON.stringify(wm2.candidates));
    check('press-mode-stops-ocr', ctx.ocr.status === 'off' && !ctx.ocr.worker && !ctx.ocr.timer, ctx.ocr.status + ' worker=' + !!ctx.ocr.worker);
    check('press-mode-no-new-mark-on-second-press', ctx.store.data.marks.filter((m) => m.t >= wm.t).length === 1);
    push();
    await sleep(500);
    await shot('04b-press-mode-done');

    // ---- built-in recording: first press records, second press stops and saves a playable-looking .webm
    const { dialog } = require('electron');
    ctx.store.updateSettings({ ocr: { enabled: false }, record: { enabled: true, dir: path.join(dir, 'rec') } });
    ctx.store.save();
    await sleep(1700);
    ctx.press();
    await sleep(1500);
    const rm = ctx.store.data.marks[0];
    check('record-first-press-starts', rm.watching === true && !rm.recordError, JSON.stringify({ w: rm.watching, err: rm.recordError }));
    await sleep(4500);
    push();
    await sleep(400);
    check('ui-recording-in-progress-text', /Recording\.\.\./.test(await ex("document.querySelector('#incidents-list .card .cliprows').textContent")));
    ctx.press();
    await sleep(4000);
    const rm2 = ctx.store.data.marks[0];
    let hdr = '', size = 0;
    try { size = fs.statSync(rm2.video.path).size; hdr = fs.readFileSync(rm2.video.path).subarray(0, 4).toString('hex'); } catch (e) { /* reported below */ }
    let hdr8 = ''; try { hdr8 = fs.readFileSync(rm2.video.path).subarray(0, 12).toString('latin1'); } catch (e) { /* reported below */ }
    const isWebm = hdr === '1a45dfa3', isMp4 = /ftyp/.test(hdr8);
    check('record-saves-playable-container', !!rm2.video && size > 3000 && (isWebm || isMp4) && /\.(webm|mp4)$/.test(rm2.video.file) && rm2.video.durationSec >= 4, JSON.stringify({ video: rm2.video, size, hdr, isMp4 }));
    check('record-stops-cleanly', rm2.watching === false && ctx.recorderIdle(), 'idle=' + ctx.recorderIdle());
    push();
    await sleep(500);
    check('ui-recording-saved-text', /Recording saved: Rap Sheet/.test(await ex("document.querySelector('#incidents-list .card .cliprows').textContent")));
    await ex("Array.from(document.querySelectorAll('#incidents-list .btns button')).find(b => /report/i.test(b.textContent)).click()");
    await sleep(900);
    const evText = await ex("document.getElementById('rp-evidence').textContent");
    check('report-evidence-lists-recording', /Recording/.test(evText) && /Rap Sheet .*\.(webm|mp4)/.test(evText), evText);
    check('report-text-mentions-recording', /Recording: Rap Sheet .*\.(webm|mp4) \(\d+ seconds/.test(await ex("document.getElementById('rp-out').value")));
    check('report-has-drag-handle', (await ex("document.querySelectorAll('#rp-evidence .dragchip[draggable=true]').length")) >= 1);
    // choose a clip with the file picker (picker stubbed here; a real dialog needs a human)
    const picked = path.join(dir, 'my-own-clip.mp4');
    fs.writeFileSync(picked, fakeMp4(20));
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
    await ex("Array.from(document.querySelectorAll('#rp-evidence .rowline')).find(r => /^Clip/.test(r.textContent)).querySelector('button:last-of-type').click()");
    await sleep(900);
    const mm = ctx.store.data.marks[0];
    check('choose-clip-attaches-file', !!mm.clip && mm.clip.path === picked && mm.clip.manual === true, JSON.stringify(mm.clip));
    check('ui-clip-row-shows-chosen-file', /my-own-clip\.mp4/.test(await ex("document.getElementById('rp-evidence').textContent")));
    check('report-text-has-chosen-clip-no-bogus-window', /Clip: my-own-clip\.mp4/.test(await ex("document.getElementById('rp-out').value")) && !/NaN|null/.test(await ex("document.getElementById('rp-out').value")));
    await shot('04c-report-evidence');
    ctx.store.updateSettings({ record: { enabled: false } });

    // ---- reading-area editor: starts from the saved box, can be moved and resized, Enter saves
    {
      const { screen } = require('electron');
      const png = 'data:image/png;base64,' + fs.readFileSync(process.env.RK_FAKE_CAPTURE).toString('base64');
      const pr = ctx.openPicker(screen.getPrimaryDisplay(), png, { width: 800, height: 450 }, { x: 100, y: 100, width: 200, height: 100 });
      await sleep(1500);
      const pw = ctx.pickerWin();
      const pex = (js) => pw.webContents.executeJavaScript(js);
      check('picker-shows-saved-box', await pex("(function(){var s=document.getElementById('sel');return !s.hidden && s.style.left==='100px' && s.style.width==='200px'})()"));
      const fire = (target, type, x, y) => pex("(function(){var t=" + target + ";t.dispatchEvent(new PointerEvent('" + type + "',{bubbles:true,clientX:" + x + ",clientY:" + y + "}))})()");
      await fire("document.getElementById('sel')", 'pointerdown', 150, 130);   // grab inside the box
      await fire('window', 'pointermove', 250, 180);                           // move by (100, 50)
      await fire('window', 'pointerup', 250, 180);
      await fire("document.querySelector('#sel .h[data-h=se]')", 'pointerdown', 400, 250); // grab the bottom-right handle
      await fire('window', 'pointermove', 450, 300);                           // grow by (50, 50)
      await fire('window', 'pointerup', 450, 300);
      await pex("window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true}))"); // nudge 10px right
      await pex("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))");
      const got = await pr;
      check('picker-move-resize-nudge-save', !!got && got.x === 210 && got.y === 150 && got.width === 250 && got.height === 150, JSON.stringify(got));
      const frac = ctx.regionTools.toFractions(got, 800, 450);
      check('picker-box-saved-as-fractions', Math.abs(frac.fx - 210 / 800) < 1e-9 && Math.abs(frac.fh - 150 / 450) < 1e-9);
      const pr2 = ctx.openPicker(screen.getPrimaryDisplay(), png, { width: 800, height: 450 }, null);
      await sleep(1200);
      await ctx.pickerWin().webContents.executeJavaScript("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
      check('picker-escape-cancels', (await pr2) === null);
    }

    // ---- wizard steps render (clips, key, screen reading, done)
    ctx.store.data.settings.firstRunDone = false;
    push();
    await sleep(500);
    for (let i = 1; i <= 4; i++) {
      await ex("document.querySelector('.wiz-card .wiz-foot .primary').click()");
      await sleep(500);
      await shot('06-wizard-step' + i);
    }
    check('wizard-walks-all-steps', await ex("/You are set|Name suggestions|incident key|Pick your incident key|Where do your clips/.test(document.querySelector('.wiz-card').textContent)"));
    ctx.store.data.settings.firstRunDone = true;

    const hkState = ctx.publicState().status.hotkey;
    check('safe-mode-is-default', hkState.mode === 'safe' && hkState.label === 'F5', JSON.stringify(hkState));
    check('safe-mode-installs-no-key-hook', ctx.hotkeys().started === false && ctx.hotkeys().hook === null);
    const setF8 = await ex("rk.setSafeHotkey('F8')");
    check('safe-key-can-change', setF8 && setF8.ok === true && ctx.publicState().status.hotkey.label === 'F8', JSON.stringify(setF8));
    const bad = await ex("rk.setSafeHotkey('Q')");
    check('bare-letter-rejected', bad && bad.ok === false, JSON.stringify(bad));
    await ex("rk.setSafeHotkey('F5')");
    check('safe-key-restored', ctx.publicState().status.hotkey.label === 'F5');
    check('no-renderer-errors', out.consoleErrors.length === 0, out.consoleErrors.join(' || '));
  } catch (e) {
    check('smoke-run-completed', false, String((e && e.stack) || e));
  }

  const failed = Object.keys(out.checks).filter((k) => !out.checks[k].ok);
  console.log('SMOKE_RESULT ' + JSON.stringify({ failed, checks: out.checks }, null, 1));
  ctx.app.exit(failed.length ? 1 : 0);
}

module.exports = { run };
