// The AI never sees who is in a group. Before writing, every sender, @mention and known name
// typed in a message becomes a label ("Member 3"). Afterwards the labels are swapped back to
// names, or to "a member" when the group is set to "Anonymise members".

import { displayName } from './rank.js';

const MENTION = /@\+?\d{6,}/g;
const LABEL = /([.!?]\s+)?\bMember (\d+)\b/g;
const NAME_KEYS = new Set(['sharedBy', 'by']);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const digits = (s) => String(s || '').split('@')[0].split(':')[0].replace(/\D/g, '');

/** @returns {{messages: object[], names: Map<string, string>}} labelled copies, and label -> real name */
export function pseudonymise(messages) {
  const labels = new Map();
  const names = new Map();
  const keyOf = (m) => (m.FromMe ? 'me' : m.SenderJID || m.MsgID);
  for (const m of messages) {
    const k = keyOf(m);
    if (labels.has(k)) continue;
    const label = `Member ${labels.size + 1}`;
    labels.set(k, label);
    names.set(label, displayName(m));
  }
  const byNumber = new Map([...labels].filter(([k]) => digits(k).length >= 6).map(([k, l]) => [digits(k), l]));
  const firsts = new Map();
  for (const [label, n] of names) {
    const first = n.split(/\s+/)[0];
    if (/^\p{Lu}\p{L}{2,}$/u.test(first)) firsts.set(first, firsts.has(first) ? null : label);
  }
  const swaps = [...names].filter(([, n]) => n && !n.startsWith('+')).map(([l, n]) => [n, l]);
  for (const [first, l] of firsts) if (l && !swaps.some(([n]) => n === first)) swaps.push([first, l]);
  swaps.sort((a, b) => b[0].length - a[0].length);
  const nameRe = swaps.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${swaps.map(([n]) => escape(n)).join('|')})(?![\\p{L}\\p{N}])`, 'gu') : null;
  const toLabel = new Map(swaps);
  const clean = (t) => {
    if (typeof t !== 'string') return t;
    const out = t.replace(MENTION, (x) => byNumber.get(x.replace(/\D/g, '')) || 'someone');
    return nameRe ? out.replace(nameRe, (n) => toLabel.get(n)) : out;
  };
  return {
    messages: messages.map((m) => ({ ...m, Anon: true, SenderName: labels.get(keyOf(m)), Text: clean(m.Text), DisplayText: clean(m.DisplayText), MediaCaption: clean(m.MediaCaption) })),
    names,
  };
}

const COUNT = ['Two', 'Three', 'Four', 'Five', 'Six'];
const MANY = /\b([aA]) member((?:, a member)*),? and a member\b/g;

const swapText = (s, names) => s
  .replace(LABEL, (_, pre, n, at) => {
    const who = (names && names.get(`Member ${n}`)) || '';
    const word = who || (pre || at === 0 ? 'A member' : 'a member');
    return `${pre || ''}${word}`;
  })
  .replace(MANY, (_, a, more) => {
    const n = 2 + (more.match(/, a member/g) || []).length;
    const word = `${COUNT[n - 2] || 'Several'} members`;
    return a === 'A' ? word : word.toLowerCase();
  })
  .replace(MENTION, 'someone');

function walk(value, fn, blankNames) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => { value[i] = typeof v === 'string' ? fn(v) : walk(v, fn, blankNames); });
  } else if (value && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) {
      if (blankNames && NAME_KEYS.has(k) && typeof v === 'string') value[k] = '';
      else if (typeof v === 'string') value[k] = fn(v);
      else walk(v, fn, blankNames);
    }
  }
  return value;
}

/** Anonymised group: drop names and labels from a built digest, in place. */
export const scrubNames = (value) => walk(value, (s) => swapText(s, null), true);

/** Named group: put real names back where the AI wrote labels, in place. */
export const restoreNames = (value, names) => walk(value, (s) => swapText(s, names), false);
