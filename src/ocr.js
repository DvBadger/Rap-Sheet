'use strict';
// Real-time screen reading: every few seconds, OCR a small region of the screen (e.g. the kill feed)
// and keep a rolling list of names that keep appearing. Runs fully offline.
const { extractCandidates, RollingNames } = require('./lib/ocrNames');
const { log } = require('./logger');

class OcrLoop {
  /**
   * @param {object} o
   * @param {() => object} o.getSettings      current settings
   * @param {() => Promise<{png:Buffer, previewDataUrl?:string}|null>} o.capture  returns the cropped region
   * @param {string} o.langPath               folder holding eng.traineddata(.gz)
   * @param {() => void} o.onUpdate
   */
  constructor(o) {
    this.o = o;
    this.names = new RollingNames({ windowMs: 45000 });
    this.debug = !!process.env.RK_SMOKE;
    this.gen = 0; // bumps on every start/stop, so a read left over from an earlier session can't block or pollute a new one
    this.worker = null;
    this.timer = null;
    this.busy = false;
    this.running = false;
    this.status = 'off'; // off | starting | running | error
    this.error = '';
    this.lastText = '';
    this.lastAt = 0;
    this.preview = '';
    this.lastTickMs = 0;
  }

  async _ensureWorker() {
    if (this.worker) return this.worker;
    const { createWorker } = require('tesseract.js');
    this.worker = await createWorker('eng', 1, { langPath: this.o.langPath, gzip: true, cacheMethod: 'none' });
    // PSM 11 = sparse text: finds scattered names (kill feeds, nameplates) without assuming a paragraph layout.
    await this.worker.setParameters({ tessedit_pageseg_mode: '11' });
    return this.worker;
  }

  async start(opts = {}) {
    if (this.running) return;
    this.running = true;
    this.gen++;
    this.busy = false;
    this.status = 'starting';
    this.error = '';
    this.o.onUpdate();
    try {
      await this._ensureWorker();
      if (!this.running) { await this.releaseIfIdle(); return; } // stopped while the engine was loading
      this.status = 'running';
      log('ocr: worker ready');
    } catch (e) {
      this.status = 'error';
      this.error = String((e && e.message) || e);
      this.running = false;
      log('ocr: failed to start', e);
      this.o.onUpdate();
      return;
    }
    this.o.onUpdate();
    this._schedule(!!opts.immediate);
  }

  async stop() {
    this.running = false;
    this.gen++;
    this.busy = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.status = 'off';
    this.names.clear();
    this.lastText = '';
    this.preview = '';
    const w = this.worker;
    this.worker = null;
    if (w) { try { await w.terminate(); } catch (e) { /* ignore */ } }
    this.o.onUpdate();
  }

  // After a one-off "Test reading", free the OCR engine if the live loop isn't using it.
  async releaseIfIdle() {
    if (this.running || !this.worker) return;
    const w = this.worker;
    this.worker = null;
    try { await w.terminate(); } catch (e) { /* ignore */ }
  }

  _schedule(immediate) {
    if (!this.running) return;
    const s = this.o.getSettings().ocr || {};
    // Press-to-watch sessions are short, so read once a second; always-on mode uses the user's interval.
    const eased = this.o.isRecording && this.o.isRecording(); // while recording, read less often so the encoder gets the CPU
    const interval = immediate ? 0 : s.mode === 'always' ? Math.max(eased ? 3000 : 1000, s.intervalMs || 2000) : (eased ? 2000 : 1000);
    // Wait out the interval after the previous pass finished, so a slow PC never piles up work.
    const gen = this.gen;
    this.timer = setTimeout(() => this._tick().finally(() => { if (gen === this.gen) this._schedule(); }), interval);
  }

  // Runs one capture+OCR pass. Also used by the "Test reading" button.
  async readOnce() {
    const s = this.o.getSettings().ocr || {};
    const cap = await this.o.capture();
    if (!cap || cap.error) return { ok: false, reason: (cap && cap.error) || 'Could not capture that part of the screen.' };
    this.preview = cap.previewDataUrl || '';
    const worker = await this._ensureWorker();
    const { data } = await worker.recognize(cap.png, {}, { blocks: true });
    const words = [];
    for (const b of data.blocks || []) {
      for (const p of b.paragraphs || []) {
        for (const l of p.lines || []) {
          for (const w of l.words || []) words.push({ text: w.text, confidence: w.confidence });
        }
      }
    }
    const tokens = extractCandidates(words, { minConf: s.minConf == null ? 60 : s.minConf });
    return { ok: true, text: (data.text || '').trim(), tokens };
  }

  async _tick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    const gen = this.gen;
    const t0 = Date.now();
    try {
      const r = await this.readOnce();
      if (gen !== this.gen) return; // this read belongs to a session that has since ended
      if (r.ok) {
        this.names.add(Date.now(), r.tokens);
        this.lastText = r.text;
        this.lastAt = Date.now();
        if (this.status !== 'running') { this.status = 'running'; this.error = ''; }
        if (this.debug) log('ocr: pass', `tokens=${r.tokens.length}`, r.tokens.slice(0, 4).map((t) => t.name || t.text || '?').join(','));
      } else {
        this.error = r.reason;
        log('ocr: pass skipped', r.reason);
      }
    } catch (e) {
      this.error = String((e && e.message) || e);
      log('ocr: pass failed', e);
    } finally {
      if (gen === this.gen) {
        this.lastTickMs = Date.now() - t0;
        this.busy = false;
        this.o.onUpdate();
      }
    }
  }

  candidates(now, minFrames) {
    const ignore = this.o.getSettings().ignoreNames || [];
    return this.names.top(now || Date.now(), { ignore, limit: 8, minFrames: minFrames || 2 });
  }

  snapshot() {
    return {
      status: this.status,
      error: this.error,
      lastText: this.lastText,
      lastAt: this.lastAt,
      lastTickMs: this.lastTickMs,
      preview: this.preview,
      candidates: this.status === 'running' ? this.candidates() : []
    };
  }
}

module.exports = { OcrLoop };
