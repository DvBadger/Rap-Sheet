'use strict';
// Small file + in-memory logger so problems can be diagnosed from the Settings tab.
const fs = require('fs');
const path = require('path');

const ring = [];
let file = null;

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'rapsheet.log');
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.writeFileSync(file, '');
    } catch (e) { /* ignore */ }
  } catch (e) { file = null; }
}

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? (p.stack || p.message) : typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  ring.push(line);
  if (ring.length > 300) ring.shift();
  if (file) {
    try { fs.appendFileSync(file, line + '\n'); } catch (e) { /* ignore */ }
  }
}

function recent() { return ring.slice(); }
function filePath() { return file; }

module.exports = { init, log, recent, filePath };
