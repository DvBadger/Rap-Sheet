'use strict';
const { fmtClock } = require('./match');

const GAMES = ['ROB RUN', 'WARDOGS', 'Other'];

const ROUTES = {
  'ROB RUN': 'The Steam page lists the developer\'s Discord and the Steam discussion boards for feedback and bug reports. It describes no dedicated cheater-report process, so post to the developer\'s Discord and attach the clip.',
  'WARDOGS': 'Use the in-game report on official servers. A community wiki says reports can include your last 50 text chat messages, so type the time and what you saw into chat first. Voice chat is not recorded. On a community server, tell that server\'s admins directly.',
  'Other': 'Use the game\'s in-game report first, then its official support page or Discord. Attach the clip and paste this text.'
};

function fmtDateTime(t, tz) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return tz ? `${s} (${tz})` : s;
}

function fmtDate(t) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * @param {object} r  {game,t,tz,server,player,behaviors[],desc,witnesses,clip?,screenshotFile?,history?}
 */
function buildReport(r) {
  const lines = [];
  const blank = (s) => (s && String(s).trim()) || '[not provided]';
  lines.push(`CHEATER REPORT - ${r.game || 'Other'}`);
  lines.push(`Date/time: ${r.t ? fmtDateTime(r.t, r.tz) : '[not provided]'}`);
  lines.push(`Server/lobby: ${blank(r.server)}`);
  lines.push(`Reported player: ${blank(r.player)}`);
  const b = r.behaviors || [];
  lines.push(`Suspected behavior: ${b.length ? b.join('; ') : '[not provided]'}`);
  lines.push('');
  lines.push('What I saw:');
  lines.push(blank(r.desc));
  lines.push('');
  if (r.clip && r.clip.file) {
    lines.push(`Clip: ${r.clip.file}`);
    if (r.clip.offsetSec != null && r.clip.windowStartSec != null) {
      lines.push(`In the clip, the incident is shortly before ${fmtClock(r.clip.offsetSec)}; look between ${fmtClock(r.clip.windowStartSec)} and ${fmtClock(r.clip.windowEndSec)}.`);
    }
  } else if (!(r.video && r.video.file)) {
    lines.push('Clip: [not attached]');
  }
  if (r.video && r.video.file) {
    const d = r.video.startDelaySec;
    lines.push(`Recording: ${r.video.file}${r.video.durationSec ? ` (${Math.round(r.video.durationSec)} seconds` + (d >= 2 ? `, starts about ${Math.round(d)} seconds after I pressed my report key, so the cheating may be just before the start)` : ', starts when I spotted it)') : ''}`);
  }
  if (r.screenshotFile) lines.push('Screenshot: attached (taken at the moment of the report)');
  lines.push(`Witnesses: ${blank(r.witnesses)}`);
  const h = r.history;
  if (h && h.count > 0) {
    lines.push('');
    lines.push(`Previous reports of this player by me: ${h.count} (first ${fmtDate(h.firstT)}, most recent ${fmtDate(h.lastT)}, across ${h.days} day${h.days === 1 ? '' : 's'}).`);
  }
  return lines.join('\n');
}

module.exports = { buildReport, GAMES, ROUTES, fmtDateTime, fmtDate };
