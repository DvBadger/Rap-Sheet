'use strict';
// Repeat-offender tracking: groups saved reports by (fuzzy) player name.
const { normalizeName, similarKeys } = require('./names');

function groupReports(reports) {
  const items = reports
    .filter((r) => r && r.player && normalizeName(r.player))
    .map((r) => ({ r, key: normalizeName(r.player) }));

  // union-find on similarity
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (similarKeys(items[i].key, items[j].key)) parent[find(j)] = find(i);
    }
  }

  const buckets = new Map();
  items.forEach((it, i) => {
    const root = find(i);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(it.r);
  });

  const groups = [];
  for (const list of buckets.values()) {
    list.sort((a, b) => a.t - b.t);
    const spellings = new Map();
    for (const r of list) spellings.set(r.player, (spellings.get(r.player) || 0) + 1);
    const names = [...spellings.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const days = new Set(list.map((r) => new Date(r.t).toDateString()));
    groups.push({
      id: normalizeName(names[0]),
      name: names[0],
      aliases: names.slice(1),
      count: list.length,
      days: days.size,
      games: [...new Set(list.map((r) => r.game).filter(Boolean))],
      servers: [...new Set(list.map((r) => r.server).filter(Boolean))],
      firstT: list[0].t,
      lastT: list[list.length - 1].t,
      reportIds: list.map((r) => r.id)
    });
  }
  groups.sort((a, b) => b.count - a.count || b.lastT - a.lastT);
  return groups;
}

// How many earlier reports (excluding excludeId) match this player name?
function historyFor(name, reports, excludeId) {
  const key = normalizeName(name);
  if (!key) return { count: 0, firstT: null, lastT: null, days: 0, games: [] };
  const hits = reports.filter((r) => r.id !== excludeId && r.player && similarKeys(key, normalizeName(r.player)));
  if (!hits.length) return { count: 0, firstT: null, lastT: null, days: 0, games: [] };
  hits.sort((a, b) => a.t - b.t);
  return {
    count: hits.length,
    firstT: hits[0].t,
    lastT: hits[hits.length - 1].t,
    days: new Set(hits.map((r) => new Date(r.t).toDateString())).size,
    games: [...new Set(hits.map((r) => r.game).filter(Boolean))]
  };
}

module.exports = { groupReports, historyFor };
