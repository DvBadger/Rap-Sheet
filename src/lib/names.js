'use strict';
// Name normalisation and fuzzy matching, shared by repeat-offender tracking and OCR candidate ranking.
// OCR misreads similar glyphs (0/O, 1/l/I), so matching folds those and allows a small edit distance.

const CONFUSABLE = { '0': 'o', '1': 'l', 'i': 'l', '|': 'l', '5': 's', '$': 's' };

function normalizeName(s) {
  const noTags = String(s || '').toLowerCase().replace(/\[[^\]]*\]/g, '');
  let out = '';
  for (const ch of noTags) {
    if (/[a-z0-9|$]/.test(ch)) out += CONFUSABLE[ch] || ch;
  }
  return out;
}

function editDistance(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Two normalised keys refer to the same player when equal, or (for longer names) within a small edit distance.
function similarKeys(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const len = Math.min(a.length, b.length);
  if (len < 5) return false;
  const max = len >= 10 ? 2 : 1;
  return editDistance(a, b, max) <= max;
}

function similarNames(a, b) {
  return similarKeys(normalizeName(a), normalizeName(b));
}

module.exports = { normalizeName, editDistance, similarKeys, similarNames };
