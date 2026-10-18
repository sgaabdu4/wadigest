// No-AI ranking: turn a week of raw wacli messages into scored items.
//
// Score = reactions × 3 + replies × 2 + re-shares × 2 + up to 3 points for how much was said
// in the replies. The same link shared several times is one item (re-shares add to it).

import { extractUrls, canonicalUrl, isVideoLink, hostOf } from './links.js';
import { truncate, wordCount } from './util.js';

export const DIGEST_MARKER = '📬'; // first character of every digest wadigest posts
export const COMMAND_PREFIX = /^\s*[!/.]digest\b/i;

const msgText = (m) => String(m.Text || m.MediaCaption || '').trim();
const MIN_POST_WORDS = 12;

export function isReaction(m) {
  return !!(m.ReactionToID && String(m.ReactionToID).trim());
}

function isRemoved(m) {
  return m.Revoked || m.DeletedForMe || m.deleted_at;
}

/** Messages that should never become digest items. */
export function isNoise(m) {
  if (isRemoved(m) || isReaction(m)) return true;
  const t = msgText(m);
  if (COMMAND_PREFIX.test(t)) return true;
  if (m.FromMe && t.startsWith(DIGEST_MARKER)) return true; // our own digest posts
  const type = String(m.MediaType || '').toLowerCase();
  if (!t && !['video', 'image', 'document'].includes(type)) return true; // stickers, empty system rows
  return false;
}

export function displayName(m) {
  if (m.Anon) return m.SenderName;
  const n = String(m.SenderName || '').trim();
  if (n && !/^\+?\d{6,}$/.test(n)) return n;
  if (m.FromMe) return 'me';
  const user = String(m.SenderJID || '').split('@')[0];
  return n || (user ? `+${user.slice(0, 4)}…${user.slice(-2)}` : 'someone');
}

/** Final reaction per (reactor, target): later reactions replace earlier ones; empty emoji removes. */
export function collectReactions(messages) {
  const latest = new Map(); // `${target}|${sender}` -> { emoji, ts }
  for (const m of messages) {
    if (!isReaction(m) || isRemoved(m)) continue;
    const key = `${m.ReactionToID}|${m.SenderJID || (m.FromMe ? 'me' : m.MsgID)}`;
    const ts = Date.parse(m.Timestamp) || 0;
    const prev = latest.get(key);
    if (!prev || ts >= prev.ts) latest.set(key, { emoji: String(m.ReactionEmoji || '').trim(), ts });
  }
  const byTarget = new Map(); // target -> Map(emoji -> count)
  for (const [key, { emoji }] of latest) {
    if (!emoji) continue;
    const target = key.split('|')[0];
    if (!byTarget.has(target)) byTarget.set(target, new Map());
    const em = byTarget.get(target);
    em.set(emoji, (em.get(emoji) || 0) + 1);
  }
  return byTarget;
}

function reactionTotal(map) {
  let n = 0;
  for (const c of map?.values?.() || []) n += c;
  return n;
}

function mergeEmoji(into, from) {
  for (const [e, c] of from || []) into.set(e, (into.get(e) || 0) + c);
}

function topEmoji(map, k = 3) {
  return [...(map || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([e]) => e);
}

/** Replies (direct and nested) under each message id. */
function buildReplyTree(messages) {
  const children = new Map();
  for (const m of messages) {
    if (isRemoved(m) || isReaction(m) || !m.QuotedMsgID) continue;
    if (!children.has(m.QuotedMsgID)) children.set(m.QuotedMsgID, []);
    children.get(m.QuotedMsgID).push(m);
  }
  const descendants = (id) => {
    const out = [];
    const seen = new Set([id]);
    const stack = [...(children.get(id) || [])];
    while (stack.length) {
      const m = stack.pop();
      if (seen.has(m.MsgID)) continue;
      seen.add(m.MsgID);
      out.push(m);
      stack.push(...(children.get(m.MsgID) || []));
    }
    return out.sort((a, b) => Date.parse(a.Timestamp) - Date.parse(b.Timestamp));
  };
  return { descendants };
}

export function scoreOf({ reactions, replies, reshares, replyWords }) {
  return reactions * 3 + replies * 2 + reshares * 2 + Math.min(3, Math.floor((replyWords || 0) / 40));
}

function stripUrls(text) {
  return String(text || '').replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '').replace(/\s+/g, ' ').trim();
}

/**
 * @param {object[]} messages wacli Message rows for one chat and one week (any order)
 * @returns {{ items: object[], stats: object }} items sorted best first (all of them; caller slices)
 */
export function rankMessages(messages) {
  const sorted = [...messages].sort((a, b) => Date.parse(a.Timestamp) - Date.parse(b.Timestamp));
  const reactions = collectReactions(sorted);
  const tree = buildReplyTree(sorted);
  const content = sorted.filter((m) => !isNoise(m));

  const linkItems = new Map(); // canonical -> item
  const items = [];
  const usedAsItem = new Set();

  for (const m of content) {
    const urls = extractUrls(msgText(m));
    const seenHere = new Set();
    for (const raw of urls) {
      const canon = canonicalUrl(raw);
      if (seenHere.has(canon)) continue;
      seenHere.add(canon);
      let item = linkItems.get(canon);
      if (!item) {
        item = {
          id: `link:${canon}`,
          kind: isVideoLink(raw) ? 'video-link' : 'link',
          url: raw,
          canonicalUrl: canon,
          host: hostOf(raw),
          title: '',
          description: '',
          text: truncate(stripUrls(msgText(m)), 280),
          sharedBy: displayName(m),
          sharedByJid: m.SenderJID || '',
          sharedAt: m.Timestamp,
          msgId: m.MsgID,
          msgIds: [],
          sharers: new Set(),
          forwards: 0,
          emoji: new Map(),
          replyMsgs: [],
        };
        linkItems.set(canon, item);
        items.push(item);
      }
      item.msgIds.push(m.MsgID);
      item.sharers.add(m.SenderJID || displayName(m));
      if (m.IsForwarded) item.forwards += 1;
      if (!item.text) item.text = truncate(stripUrls(msgText(m)), 280);
      mergeEmoji(item.emoji, reactions.get(m.MsgID));
      for (const r of tree.descendants(m.MsgID)) if (!item.replyMsgs.some((x) => x.MsgID === r.MsgID)) item.replyMsgs.push(r);
      usedAsItem.add(m.MsgID);
    }
    if (!urls.length && String(m.MediaType || '').toLowerCase() === 'video') {
      items.push({
        id: `video:${m.MsgID}`,
        kind: 'video',
        url: '',
        title: '',
        description: '',
        text: truncate(msgText(m), 280),
        filename: m.Filename || '',
        mimeType: m.MimeType || '',
        chatJid: m.ChatJID,
        sharedBy: displayName(m),
        sharedByJid: m.SenderJID || '',
        sharedAt: m.Timestamp,
        msgId: m.MsgID,
        msgIds: [m.MsgID],
        sharers: new Set([m.SenderJID]),
        forwards: m.IsForwarded ? 1 : 0,
        emoji: new Map(reactions.get(m.MsgID) || []),
        replyMsgs: tree.descendants(m.MsgID),
      });
      usedAsItem.add(m.MsgID);
    }
  }

  // Busy threads: any other message with at least 2 replies under it.
  for (const m of content) {
    if (usedAsItem.has(m.MsgID)) continue;
    const replies = tree.descendants(m.MsgID).filter((r) => !usedAsItem.has(r.MsgID));
    if (replies.length < 2) continue;
    const people = new Set(replies.map((r) => r.SenderJID).concat(m.SenderJID));
    items.push({
      id: `thread:${m.MsgID}`,
      kind: 'thread',
      url: '',
      title: truncate(msgText(m) || '(media)', 90),
      description: '',
      text: truncate(msgText(m), 280),
      sharedBy: displayName(m),
      sharedByJid: m.SenderJID || '',
      sharedAt: m.Timestamp,
      msgId: m.MsgID,
      msgIds: [m.MsgID],
      sharers: new Set([m.SenderJID]),
      forwards: 0,
      emoji: new Map(reactions.get(m.MsgID) || []),
      replyMsgs: replies,
      people: people.size,
    });
    usedAsItem.add(m.MsgID);
    for (const r of replies) usedAsItem.add(r.MsgID);
  }
  // Replies already shown under a link or thread are not separate items.
  for (const it of items) for (const r of it.replyMsgs) usedAsItem.add(r.MsgID);

  // Anything else with real content counts too, reactions or not: useful context is often quiet.
  for (const m of content) {
    if (usedAsItem.has(m.MsgID) || wordCount(msgText(m)) < MIN_POST_WORDS) continue;
    const replies = tree.descendants(m.MsgID).filter((r) => !usedAsItem.has(r.MsgID));
    items.push({
      id: `post:${m.MsgID}`,
      kind: 'post',
      url: '',
      title: truncate(msgText(m), 90),
      description: '',
      text: truncate(msgText(m), 280),
      sharedBy: displayName(m),
      sharedByJid: m.SenderJID || '',
      sharedAt: m.Timestamp,
      msgId: m.MsgID,
      msgIds: [m.MsgID],
      sharers: new Set([m.SenderJID]),
      forwards: 0,
      emoji: new Map(reactions.get(m.MsgID) || []),
      replyMsgs: replies,
      people: 1,
    });
    usedAsItem.add(m.MsgID);
  }

  // In a quiet chat, short messages are all there is: never call it quiet when people talked.
  if (items.length < 3) {
    for (const m of content) {
      if (usedAsItem.has(m.MsgID) || !msgText(m)) continue;
      items.push({
        id: `post:${m.MsgID}`, kind: 'post', url: '', title: truncate(msgText(m), 90), description: '', text: truncate(msgText(m), 280),
        sharedBy: displayName(m), sharedByJid: m.SenderJID || '', sharedAt: m.Timestamp, msgId: m.MsgID, msgIds: [m.MsgID],
        sharers: new Set([m.SenderJID]), forwards: 0, emoji: new Map(reactions.get(m.MsgID) || []), replyMsgs: [], people: 1,
      });
      usedAsItem.add(m.MsgID);
    }
  }

  const finished = items.map((it) => {
    const replyWords = it.replyMsgs.reduce((n, r) => n + wordCount(msgText(r)), 0);
    const out = {
      ...it,
      reactions: reactionTotal(it.emoji),
      topEmoji: topEmoji(it.emoji),
      replies: it.replyMsgs.length,
      reshares: Math.max(0, it.sharers.size - 1) + (it.kind === 'thread' ? 0 : it.forwards),
      replyWords,
      replySnippets: it.replyMsgs.slice(0, 5).map((r) => ({ by: displayName(r), text: truncate(msgText(r), 200) })).filter((r) => r.text),
      timesShared: it.msgIds.length,
    };
    out.score = scoreOf(out);
    delete out.emoji;
    delete out.sharers;
    delete out.replyMsgs;
    delete out.forwards;
    return out;
  });

  finished.sort((a, b) => b.score - a.score || Date.parse(b.sharedAt) - Date.parse(a.sharedAt));

  const senders = new Set(content.map((m) => m.SenderJID || (m.FromMe ? 'me' : '')).filter(Boolean));
  const stats = {
    messages: content.length,
    people: senders.size,
    links: finished.filter((i) => i.kind === 'link' || i.kind === 'video-link').length,
    videos: finished.filter((i) => i.kind === 'video' || i.kind === 'video-link').length,
    reactions: [...reactions.values()].reduce((n, mp) => n + reactionTotal(mp), 0),
  };
  return { items: finished, stats };
}
