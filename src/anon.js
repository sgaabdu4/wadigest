// "Anonymise members": the AI sees stand-in labels so it can follow who replied to whom,
// and no name, label or @mention reaches the summary.

const MENTION = /@\+?\d{6,}/g;
const LABEL = /([.!?]\s+)?\bMember \d+\b/g;
const NAME_KEYS = new Set(['sharedBy', 'by']);

export function anonymiseMessages(messages) {
  const labels = new Map();
  const label = (m) => {
    const k = m.FromMe ? 'me' : m.SenderJID || m.MsgID;
    if (!labels.has(k)) labels.set(k, `Member ${labels.size + 1}`);
    return labels.get(k);
  };
  const clean = (t) => (typeof t === 'string' ? t.replace(MENTION, '@someone') : t);
  return messages.map((m) => ({ ...m, Anon: true, SenderName: label(m), Text: clean(m.Text), DisplayText: clean(m.DisplayText), MediaCaption: clean(m.MediaCaption) }));
}

const scrubText = (s) => s.replace(LABEL, (_, pre, at) => (pre ? `${pre}A member` : at === 0 ? 'A member' : 'a member')).replace(MENTION, '@someone');

/** Removes names and stand-in labels from a built digest, in place. */
export function scrubNames(value) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => { value[i] = typeof v === 'string' ? scrubText(v) : scrubNames(v); });
  } else if (value && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) {
      if (NAME_KEYS.has(k) && typeof v === 'string') value[k] = '';
      else if (typeof v === 'string') value[k] = scrubText(v);
      else scrubNames(v);
    }
  }
  return value;
}
