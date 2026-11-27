'use strict';
// Hidden helper window. Records ONLY the game window picture (the main process hands it that one window)
// and streams the video to disk in 1-second pieces, so memory use stays small.
// Encoder choice: H.264 first (the graphics card encodes it, so the game and stream keep the CPU),
// then software VP8 only if H.264 cannot produce video on this PC.
(function () {
  var mr = null, stream = null, queue = Promise.resolve(), gotFirst = false;

  function supported(m) { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } }

  // The three mp4 spellings use the same encoder, so if one stays silent the others will too. Try mp4 once,
  // then H.264 in webm, then VP8. Whatever worked last time goes first, so a PC where mp4 stalls under game load
  // does not wait for it again at the start of every incident.
  function candidates(encoder, prefer) {
    var mp4 = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4'].filter(supported).slice(0, 1);
    var h264 = mp4.concat(['video/webm;codecs=h264'].filter(supported));
    var vp8 = ['video/webm;codecs=vp8', 'video/webm'].filter(supported).slice(0, 1);
    var list = encoder === 'vp8' ? vp8 : encoder === 'h264' ? h264 : h264.concat(vp8);
    if (prefer && list.indexOf(prefer) > 0) { list.splice(list.indexOf(prefer), 1); list.unshift(prefer); }
    return list;
  }

  // Test hook only: draw a moving picture instead of capturing a window.
  function fakeStream(w, h, fps) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d'), n = 0;
    setInterval(function () { n++; g.fillStyle = 'rgb(' + (n * 7 % 255) + ',60,120)'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.fillText('frame ' + n, 20, 40); }, 1000 / fps);
    return c.captureStream(fps);
  }

  // Try one encoder. Resolves true once it has actually produced data, false if it errors or stays silent.
  function tryMime(mime, bps) {
    return new Promise(function (resolve) {
      var rec;
      try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bps }); } catch (e) { resolve(false); return; }
      var settled = false, timer = null;
      var done = function (ok) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) { try { if (rec.state !== 'inactive') { rec.ondataavailable = null; rec.onstop = null; rec.stop(); } } catch (e) { /* ignore */ } }
        resolve(ok);
      };
      rec.onerror = function () { done(false); };
      rec.ondataavailable = function (e) {
        if (!e.data || !e.data.size) return;
        if (!settled) { mr = rec; gotFirst = true; done(true); }
        queue = queue.then(function () { return e.data.arrayBuffer(); }).then(function (ab) { window.rec.chunk(ab); });
      };
      rec.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        queue.then(function () { window.rec.stopped(); });
      };
      timer = setTimeout(function () { done(false); }, 4000);
      try { rec.start(1000); } catch (e) { done(false); }
    });
  }

  window.__start = async function (o) {
    try {
      gotFirst = false; mr = null; queue = Promise.resolve();
      var t0 = performance.now();
      stream = o.fake
        ? fakeStream(o.maxW, o.maxH, o.fps)
        : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: o.fps, max: o.fps }, width: { max: o.maxW }, height: { max: o.maxH } }, audio: false });
      var capMs = Math.round(performance.now() - t0);
      var list = candidates(o.encoder, o.prefer), tried = [];
      var ok = false, used = '';
      for (var i = 0; i < list.length && !ok; i++) {
        tried.push(list[i]);
        ok = await tryMime(list[i], o.bps);
        if (ok) used = list[i];
      }
      if (!ok) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        return { ok: false, error: 'No video encoder worked on this PC (tried: ' + tried.join(', ') + ').' };
      }
      // If the game window closes, the track ends: finish cleanly.
      stream.getVideoTracks()[0].addEventListener('ended', function () { if (mr && mr.state !== 'inactive') mr.stop(); });
      startCounting();
      var s = stream.getVideoTracks()[0].getSettings();
      return { ok: true, width: s.width || 0, height: s.height || 0, fps: s.frameRate || 0, mime: used, skipped: tried.slice(0, -1), capMs: capMs, encMs: Math.round(performance.now() - t0) - capMs };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };

  // Counts frames the capture actually delivers, so a slow capture shows up in the log as a number.
  var count = { frames: 0, t0: 0, reader: null };
  function startCounting() {
    try {
      if (typeof MediaStreamTrackProcessor === 'undefined') return;
      var track = stream.getVideoTracks()[0].clone();
      var proc = new MediaStreamTrackProcessor({ track: track });
      count.reader = proc.readable.getReader();
      count.frames = 0; count.t0 = performance.now(); count.track = track;
      (function pump() {
        count.reader.read().then(function (r) {
          if (r.done) return;
          count.frames++; r.value.close(); pump();
        }).catch(function () { /* stream ended */ });
      })();
    } catch (e) { /* diagnostics only */ }
  }
  function reportCount() {
    if (!count.reader) return;
    var sec = (performance.now() - count.t0) / 1000;
    try { window.rec.stats({ frames: count.frames, seconds: Math.round(sec * 10) / 10, fps: Math.round(count.frames / Math.max(sec, 0.1) * 10) / 10 }); } catch (e) { /* ignore */ }
    try { count.reader.cancel(); count.track.stop(); } catch (e) { /* ignore */ }
    count.reader = null;
  }

  window.__stop = function () {
    reportCount();
    if (mr && mr.state !== 'inactive') mr.stop();
    else window.rec.stopped();
    return true;
  };
})();
