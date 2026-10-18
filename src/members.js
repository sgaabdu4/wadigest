// Opted-in members (members.json) and interest matching.

import fs from 'node:fs';
import { paths, writeJsonAtomic } from './config.js';
import { jidUser } from './util.js';

export function loadMembers() {
  try {
    const list = JSON.parse(fs.readFileSync(paths().members, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export function saveMembers(list) {
  writeJsonAtomic(paths().members, list);
}

/** Members are matched by the user part of their JID, so phone and @lid forms both find them. */
export function findMember(list, jid) {
  const u = jidUser(jid);
  return list.find((m) => m.jid === jid || jidUser(m.jid) === u || (m.altJids || []).some((a) => jidUser(a) === u));
}

export function upsertMember(list, { jid, name, interests }) {
  let m = findMember(list, jid);
  const now = new Date().toISOString();
  if (!m) {
    m = { jid, name: name || '', interests: [], active: true, joinedAt: now };
    list.push(m);
  }
  if (name) m.name = name;
  if (interests) m.interests = interests;
  m.active = true;
  m.updatedAt = now;
  return m;
}

function stem(word) {
  return word.toLowerCase().replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
}

/** Which of a member's interests an item matches (case-insensitive, whole words, simple plurals). */
export function matchInterests(item, interests) {
  const hay = [item.title, item.text, item.description, item.url, item.host, item.summary, item.transcript, ...(item.tags || [])]
    .filter(Boolean).join(' ').toLowerCase();
  const words = new Set((hay.match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/gu) || []).map((w) => stem(w.replace(/[.-]+$/, ''))));
  const matched = [];
  for (const interest of interests || []) {
    const parts = interest.toLowerCase().split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const hit = parts.length === 1
      ? words.has(stem(parts[0])) || (parts[0].length >= 4 && hay.includes(parts[0]))
      : hay.includes(interest.toLowerCase());
    if (hit) matched.push(interest);
  }
  return matched;
}
