// WhatsApp text rendering for the group post and the personal DMs.
// WhatsApp formatting: *bold*, _italic_, ~strike~, ```mono```.

import { DIGEST_MARKER } from './rank.js';
import { matchInterests } from './members.js';
import { truncate, plural } from './util.js';

const KIND_ICON = { link: '🔗', 'video-link': '🎬', video: '🎬', thread: '💬', post: '📝' };

function dateRange(window, timeZone) {
  const s = new Date(window.start);
  const e = new Date(new Date(window.end).getTime() - 1);
  const day = (d) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone }).format(d);
  const mon = (d) => new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone }).format(d);
  return mon(s) === mon(e) ? `${day(s)}–${day(e)} ${mon(e)}` : `${day(s)} ${mon(s)} – ${day(e)} ${mon(e)}`;
}

function cleanForBold(s) {
  // Asterisks inside a title would break WhatsApp bold.
  return String(s || '').replace(/[*_~`]/g, '').trim();
}

export function itemTitle(item) {
  if (item.title) return truncate(cleanForBold(item.title), 90);
  if (item.kind === 'video') return item.text ? truncate(cleanForBold(item.text), 90) : item.sharedBy ? `Video from ${item.sharedBy}` : 'A video';
  if (item.host) return item.host;
  return truncate(cleanForBold(item.text), 90) || 'Untitled';
}

function engagement(item) {
  const bits = item.sharedBy ? [`👤 ${item.sharedBy}`] : [];
  if (item.reactions) bits.push(`${item.topEmoji?.[0] || '👍'} ${item.reactions}`);
  if (item.replies) bits.push(`💬 ${item.replies}`);
  if (item.reshares) bits.push(`🔁 ${item.reshares}`);
  return bits.join(' · ');
}

function linkLines(item) {
  const icon = KIND_ICON[item.kind] || '🔗';
  const seen = new Set();
  const urls = (item.urls?.length ? item.urls : item.url ? [item.canonicalUrl || item.url] : []).filter((u) => {
    const key = String(u).replace(/\/+$/, '').toLowerCase();
    return !seen.has(key) && seen.add(key);
  });
  if (urls.length) return urls.map((u) => `${icon} ${u}`);
  if (item.kind === 'video') return [`${icon} video in the chat${item.sharedAt ? `, ${new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(item.sharedAt))}` : ''}`];
  return [];
}

/** compact: one short block for the long tail of a "everything shared" list. */
function renderItem(item, n, { star = false, matched = [], compact = false } = {}) {
  const meta = engagement(item) + (matched.length ? `${engagement(item) ? ' · ' : ''}for you: ${matched.join(', ')}` : '');
  if (compact) return [`${star ? '⭐ ' : ''}*${n}. ${itemTitle(item)}*${meta ? `  ${meta}` : ''}`, ...linkLines(item).slice(0, 1)].join('\n');
  const lines = [`${star ? '⭐ ' : ''}*${n}. ${itemTitle(item)}*`];
  if (item.summary) lines.push(truncate(item.summary, 500));
  lines.push(...linkLines(item));
  if (meta) lines.push(meta);
  return lines.join('\n');
}

const FULL_ITEMS = 5;
const compactAfter = (digest) => (digest.source === 'wadigest' ? FULL_ITEMS : Infinity);

function period(digest) {
  const days = Math.round((Date.parse(digest.window?.end) - Date.parse(digest.window?.start)) / 864e5);
  return { 1: 'daily', 7: 'weekly', 14: 'fortnightly' }[days] || '';
}

/** @param {object} digest the summary contract (see summary.js) */
const SIGNATURE = 'Made with wadigest: github.com/sgaabdu4/wadigest';

export function renderGroupPost(digest, { timeZone, audience = 'everyone' } = {}) {
  const s = digest.stats || {};
  const head = [
    `${DIGEST_MARKER} *${period(digest) ? `${period(digest).charAt(0).toUpperCase()}${period(digest).slice(1)} digest` : 'Digest'}${digest.group?.name ? ` · ${cleanForBold(digest.group.name)}` : ''}*`,
    `_${dateRange(digest.window, timeZone)}${s.messages ? ` · ${plural(s.messages, 'message')} from ${plural(s.people || 0, 'person', 'people')}` : ''}_`,
  ];
  if (digest.intro) head.push('', truncate(digest.intro, 400));
  const body = digest.items.length
    ? digest.items.map((it, i) => renderItem(it, i + 1, { compact: i >= compactAfter(digest) })).join('\n\n')
    : 'All quiet, nothing stood out. 🌙';
  const foot = digest.footer ?? (audience === 'everyone'
    ? '_Everyone here gets a copy by DM too. Want your picks first? Send *!digest interests agents, n8n* · No DMs: *!digest stop*_'
    : audience === 'opted-in'
      ? '_Want your own copy with your interests first? Send *!digest join agents, n8n*_'
      : '');
  return [head.join('\n'), body, foot, SIGNATURE].filter(Boolean).join('\n\n');
}

/** Personal version: interest matches first (⭐), then the rest, plus up to 3 extra matches from beyond the top list. */
export function renderPersonal(digest, member, { timeZone } = {}) {
  const interests = member.interests || [];
  const scored = digest.items.map((it) => ({ it, matched: matchInterests(it, interests) }));
  const hits = scored.filter((x) => x.matched.length);
  const rest = scored.filter((x) => !x.matched.length);
  const extras = (digest.extras || [])
    .map((it) => ({ it, matched: matchInterests(it, interests) }))
    .filter((x) => x.matched.length)
    .slice(0, 3);

  const first = (member.name || '').split(/\s+/)[0];
  const head = [
    `${DIGEST_MARKER} *Your ${period(digest) ? `${period(digest)} ` : ''}digest${digest.group?.name ? ` · ${cleanForBold(digest.group.name)}` : ''}*`,
    `_${dateRange(digest.window, timeZone)}_`,
    '',
    interests.length
      ? (hits.length || extras.length
        ? `${first ? `Hi ${first}! ` : ''}Picks for *${interests.join(', ')}* come first ⭐`
        : `${first ? `Hi ${first}! ` : ''}Nothing matched *${interests.join(', ')}* this time, so here's everything.`)
      : `${first ? `Hi ${first}! ` : ''}Here's what happened. Add interests with *!digest interests …* to get your picks first.`,
  ];
  let n = 0;
  const blocks = [];
  for (const { it, matched } of hits) blocks.push(renderItem(it, ++n, { star: true, matched }));
  for (const { it } of rest) blocks.push(renderItem(it, ++n, { compact: n > compactAfter(digest) }));
  if (extras.length) {
    blocks.push('*Also for you*');
    for (const { it, matched } of extras) blocks.push(renderItem(it, ++n, { star: true, matched }));
  }
  if (!blocks.length) blocks.push('All quiet, nothing stood out. 🌙');
  return [head.join('\n'), blocks.join('\n\n'), '_Reply *!digest interests …* to change topics, *!digest stop* to stop these._', SIGNATURE].join('\n\n');
}
