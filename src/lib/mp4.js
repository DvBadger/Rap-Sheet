'use strict';
// Reads the duration of an MP4/MOV file from its 'moov > mvhd' box without loading the whole file.
// Returns seconds, or null if it can't be determined (fragmented MP4, MKV, unreadable file).
const fs = require('fs');

function readBoxHeader(fd, pos, fileSize) {
  const buf = Buffer.alloc(16);
  const n = fs.readSync(fd, buf, 0, 16, pos);
  if (n < 8) return null;
  let size = buf.readUInt32BE(0);
  const type = buf.toString('latin1', 4, 8);
  let header = 8;
  if (size === 1) {
    if (n < 16) return null;
    size = Number(buf.readBigUInt64BE(8));
    header = 16;
  } else if (size === 0) {
    size = fileSize - pos;
  }
  if (size < header) return null;
  return { type, size, header };
}

function findChild(buf, start, end, wanted) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return null;
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header) return null;
    if (type === wanted) return { start: pos + header, end: Math.min(pos + size, end) };
    pos += size;
  }
  return null;
}

function parseMvhd(buf, start) {
  const version = buf.readUInt8(start);
  let timescale;
  let duration;
  if (version === 1) {
    if (start + 32 > buf.length) return null;
    timescale = buf.readUInt32BE(start + 20);
    duration = Number(buf.readBigUInt64BE(start + 24));
  } else {
    if (start + 20 > buf.length) return null;
    timescale = buf.readUInt32BE(start + 12);
    duration = buf.readUInt32BE(start + 16);
  }
  if (!timescale || !duration) return null;
  return duration / timescale;
}

function mp4DurationSec(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const fileSize = fs.fstatSync(fd).size;
    let pos = 0;
    while (pos + 8 <= fileSize) {
      const h = readBoxHeader(fd, pos, fileSize);
      if (!h) return null;
      if (h.type === 'moov') {
        const len = Math.min(h.size - h.header, 64 * 1024 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos + h.header);
        const mvhd = findChild(buf, 0, len, 'mvhd');
        return mvhd ? parseMvhd(buf, mvhd.start) : null;
      }
      pos += h.size;
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { mp4DurationSec };
