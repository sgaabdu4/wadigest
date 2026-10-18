import { isGroupJid } from './util.js';

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Groups whose name matches: exact (ignoring case, emoji, punctuation) first, otherwise "contains". */
export function findGroups(groups, query) {
  if (isGroupJid(query)) return groups.filter((g) => g.jid === query);
  const q = norm(query);
  if (!q) return [];
  const exact = groups.filter((g) => norm(g.name) === q);
  if (exact.length) return exact;
  if (q.length < 2) return [];
  return groups.filter((g) => norm(g.name).includes(q));
}
