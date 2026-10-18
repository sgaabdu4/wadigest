// WhatsApp text rendering for the group post and the personal DMs.
// WhatsApp formatting: *bold*, _italic_, ~strike~, ```mono```.

import { DIGEST_MARKER } from './rank.js';
import { matchInterests } from './members.js';
import { truncate, plural } from './util.js';

const KIND_ICON = { link: '🔗', 'video-link': '🎬', video: '🎬', thread: '💬' };

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
  if (item.kind === 'video') return item.text ? truncate(cleanForBold(item.text), 90) : `Video from ${item.sharedBy}`;
  if (item.host) return item.host;
  return truncate(cleanForBold(item.text), 90) || 'Untitled';
}

function engagement(item) {
  const bits = [`👤 ${item.sharedBy}`];
  if (item.reactions) bits.push(`${item.topEmoji?.[0] || '👍'} ${item.reactions}`);
  if (item.replies) bits.push(`💬 ${item.replies}`);
  if (item.reshares) bits.push(`🔁 ${item.reshares}`);
  return bits.join(' · ');
}

function renderItem(item, n, { star = false, matched = [] } = {}) {
  const lines = [];
  const icon = KIND_ICON[item.kind] || '•';
  lines.push(`${star ? '⭐ ' : ''}*${n}. ${itemTitle(item)}*`);
  if (item.summary) lines.push(truncate(item.summary, 320));
  if (item.url) lines.push(`${icon} ${item.canonicalUrl || item.url}`);
  else if (item.kind === 'video') lines.push(`${icon} video in the chat${item.sharedAt ? `, ${new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(item.sharedAt))}` : ''}`);
  lines.push(engagement(item) + (matched.length ? ` · for you: ${matched.join(', ')}` : ''));
  return lines.join('\n');
}

function period(digest) {
  const days = Math.round((Date.parse(digest.window?.end) - Date.parse(digest.window?.start)) / 864e5);
  return { 1: 'daily', 7: 'weekly', 14: 'fortnightly' }[days] || '';
}

/** @param {object} digest the summary contract (see summary.js) */
export function renderGroupPost(digest, { timeZone, audience = 'everyone' } = {}) {
  const s = digest.stats || {};
  const head = [
    `${DIGEST_MARKER} *${period(digest) ? `${period(digest).charAt(0).toUpperCase()}${period(digest).slice(1)} digest` : 'Digest'}${digest.group?.name ? ` · ${cleanForBold(digest.group.name)}` : ''}*`,
    `_${dateRange(digest.window, timeZone)}${s.messages ? ` · ${plural(s.messages, 'message')} from ${plural(s.people || 0, 'person', 'people')}` : ''}_`,
  ];
  if (digest.intro) head.push('', truncate(digest.intro, 400));
  const body = digest.items.length
    ? digest.items.map((it, i) => renderItem(it, i + 1)).join('\n\n')
    : 'All quiet, nothing stood out. 🌙';
  const foot = digest.footer ?? (audience === 'everyone'
    ? '_Everyone here gets a copy by DM too. Want your picks first? Send *!digest interests agents, n8n* · No DMs: *!digest stop*_'
    : audience === 'opted-in'
      ? '_Want your own copy with your interests first? Send *!digest join agents, n8n*_'
      : '');
  return [head.join('\n'), body, foot].filter(Boolean).join('\n\n');
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
        : `${first ? `Hi ${first}! ` : ''}Nothing matched *${interests.join(', ')}* this time, so here's the full top ${digest.items.length}.`)
      : `${first ? `Hi ${first}! ` : ''}Here's the top ${digest.items.length}. Add interests with *!digest interests …* to get your picks first.`,
  ];
  let n = 0;
  const blocks = [];
  for (const { it, matched } of hits) blocks.push(renderItem(it, ++n, { star: true, matched }));
  for (const { it } of rest) blocks.push(renderItem(it, ++n));
  if (extras.length) {
    blocks.push('*Also for you*');
    for (const { it, matched } of extras) blocks.push(renderItem(it, ++n, { star: true, matched }));
  }
  if (!blocks.length) blocks.push('All quiet, nothing stood out. 🌙');
  return [head.join('\n'), blocks.join('\n\n'), '_Reply *!digest interests …* to change topics, *!digest stop* to stop these._'].join('\n\n');
}
