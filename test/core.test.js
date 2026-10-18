import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrl, extractUrls, parseHtmlMeta, youtubeId } from '../src/links.js';
import { rankMessages, collectReactions } from '../src/rank.js';
import { parseCommand, applyCommand } from '../src/commands.js';
import { matchInterests } from '../src/members.js';
import { renderGroupPost, renderPersonal } from '../src/format.js';
import { buildDigest, mergeSummary, extractJson } from '../src/summary.js';
import { msg, reaction } from './helpers.js';
import { pseudonymise, scrubNames, restoreNames } from '../src/anon.js';
import { buildTranscript } from '../src/fullsummary.js';

test('links: extraction and canonicalisation dedupe the same link', () => {
  assert.deepEqual(extractUrls('look https://x.com/a/status/1?s=20 and (https://example.com/page).'), ['https://x.com/a/status/1?s=20', 'https://example.com/page']);
  assert.equal(canonicalUrl('https://www.Example.com/page/?utm_source=wa&b=2&a=1'), 'https://example.com/page?a=1&b=2');
  assert.equal(canonicalUrl('https://youtu.be/dQw4w9WgXcQ?si=abc'), 'https://youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(canonicalUrl('https://m.youtube.com/shorts/dQw4w9WgXcQ'), 'https://youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(canonicalUrl('https://twitter.com/a/status/1?s=20'), canonicalUrl('https://x.com/a/status/1'));
  assert.equal(youtubeId('https://www.youtube.com/watch?v=abcdefghijk&t=10'), 'abcdefghijk');
});

test('links: html meta parsing prefers og tags and decodes entities', () => {
  const html = '<head><title>Fallback</title><meta property="og:title" content="Cursor &amp; Claude"><meta name="description" content="An editor."></head>';
  assert.deepEqual(parseHtmlMeta(html), { title: 'Cursor & Claude', description: 'An editor.', siteName: '' });
});

test('rank: reactions are counted once per person, last reaction wins, removal clears', () => {
  const m = msg({ MsgID: 'T', Text: 'https://n8n.io cool' });
  const a = '447700000001@s.whatsapp.net';
  const b = '447700000002@s.whatsapp.net';
  const rows = [m,
    reaction('T', a, '👍', { Timestamp: '2026-10-14T10:00:00Z' }),
    reaction('T', a, '🔥', { Timestamp: '2026-10-14T10:05:00Z' }),
    reaction('T', b, '👍', { Timestamp: '2026-10-14T10:00:00Z' }),
    reaction('T', b, '', { Timestamp: '2026-10-14T11:00:00Z' })];
  const r = collectReactions(rows).get('T');
  assert.deepEqual([...r.entries()], [['🔥', 1]]);
});

test('rank: same link shared twice is one item with a re-share; replies and reactions score', () => {
  const t0 = Date.parse('2026-10-13T09:00:00Z');
  const at = (h) => new Date(t0 + h * 3600e3).toISOString();
  const rows = [
    msg({ MsgID: 'L1', Text: 'try this https://cursor.com/agents?utm_source=x', SenderName: 'Sam', Timestamp: at(0) }),
    msg({ MsgID: 'L2', Text: 'https://www.cursor.com/agents', SenderJID: 'other@s.whatsapp.net', SenderName: 'Ali', Timestamp: at(5) }),
    msg({ MsgID: 'R1', Text: 'been using it all week, the background agents are great', QuotedMsgID: 'L1', Timestamp: at(1) }),
    msg({ MsgID: 'R2', Text: 'same', QuotedMsgID: 'R1', Timestamp: at(2) }),
    reaction('L1', 'x1@s.whatsapp.net', '🔥', { Timestamp: at(1) }),
    reaction('L2', 'x2@s.whatsapp.net', '🔥', { Timestamp: at(6) }),
    msg({ MsgID: 'Q', Text: 'quiet link https://example.org', Timestamp: at(3) }),
    msg({ MsgID: 'TH', Text: 'Which vector DB are you all using?', Timestamp: at(4) }),
    msg({ MsgID: 'TH1', Text: 'pgvector', QuotedMsgID: 'TH', Timestamp: at(4.1) }),
    msg({ MsgID: 'TH2', Text: 'qdrant', QuotedMsgID: 'TH', Timestamp: at(4.2) }),
    msg({ MsgID: 'TH3', Text: 'lancedb for local', QuotedMsgID: 'TH2', Timestamp: at(4.3) }),
    msg({ MsgID: 'C', Text: '!digest join agents', Timestamp: at(7) }),
    msg({ MsgID: 'D', Text: '📬 *Weekly digest*', FromMe: true, Timestamp: at(8) }),
    msg({ MsgID: 'X', Text: 'deleted https://spam.example', Revoked: true, Timestamp: at(9) }),
  ];
  const { items, stats } = rankMessages(rows);
  const cursor = items.find((i) => i.canonicalUrl === 'https://cursor.com/agents');
  assert.ok(cursor, 'cursor link item exists');
  assert.equal(cursor.timesShared, 2);
  assert.equal(cursor.reshares, 1);
  assert.equal(cursor.reactions, 2);
  assert.equal(cursor.replies, 2);
  assert.equal(items[0].id, cursor.id, 'most engaged item first');
  const thread = items.find((i) => i.kind === 'thread');
  assert.equal(thread.msgId, 'TH');
  assert.equal(thread.replies, 3);
  assert.ok(!items.some((i) => i.url?.includes('spam')), 'revoked messages ignored');
  assert.ok(!items.some((i) => i.text?.includes('!digest')), 'commands ignored');
  assert.equal(stats.links, 2);
  assert.equal(stats.messages, 9); // excludes reactions, the command, our own digest and the revoked one
});

test('rank: uploaded videos become items', () => {
  const { items } = rankMessages([msg({ MsgID: 'V', MediaType: 'video', MediaCaption: 'demo of my n8n flow', Filename: 'a.mp4' })]);
  assert.equal(items[0].kind, 'video');
  assert.equal(items[0].text, 'demo of my n8n flow');
});

test('commands: parse, join, interests, status, stop', () => {
  assert.equal(parseCommand('hello'), null);
  assert.deepEqual(parseCommand('!digest join agents, n8n'), { verb: 'join', arg: 'agents, n8n' });
  assert.deepEqual(parseCommand('!Digest'), { verb: 'help', arg: '' });
  const members = [];
  const who = { senderJid: '447700000001@s.whatsapp.net', senderName: 'Sam' };
  let r = applyCommand(parseCommand('!digest join Agents, n8n, #cursor'), who, members, { groupName: 'Developer Bros', schedule: { day: 'sunday', time: '09:00' } });
  assert.ok(r.changed && /You're in/.test(r.reply) && /Sundays at 09:00/.test(r.reply));
  assert.deepEqual(members[0].interests, ['agents', 'n8n', 'cursor']);
  r = applyCommand(parseCommand('!digest interests design'), { ...who, senderJid: '447700000001@lid' }, members);
  assert.deepEqual(members[0].interests, ['design'], 'lid and phone JIDs of the same user match');
  assert.match(applyCommand(parseCommand('!digest status'), who, members).reply, /design/);
  applyCommand(parseCommand('!digest stop'), who, members);
  assert.equal(members[0].active, false);
});

test('interests: whole words and plurals, not substrings', () => {
  const item = { title: 'Building AI agents with n8n workflows', text: '', url: 'https://n8n.io' };
  assert.deepEqual(matchInterests(item, ['agent', 'workflow', 'n8n', 'art']), ['agent', 'workflow', 'n8n']);
});

function sampleDigest() {
  const { items, stats } = rankMessages([
    msg({ MsgID: 'A', Text: 'https://n8n.io/agents check this' }),
    reaction('A', 'r1@s.whatsapp.net'),
    msg({ MsgID: 'B', Text: 'https://figma.com/blog/design-systems' }),
  ]);
  items[0].title = 'n8n AI agents';
  items[1].title = 'Design systems at scale';
  return buildDigest({ items, stats }, { group: { jid: 'g@g.us', name: 'Developer Bros' }, window: { start: '2026-10-11T08:00:00Z', end: '2026-10-18T08:00:00Z' }, topN: 5 });
}

test('format: group post has header, items, links and opt-in footer', () => {
  const text = renderGroupPost(sampleDigest(), { timeZone: 'Europe/London' });
  assert.match(text, /^📬 \*Weekly digest · Developer Bros\*/);
  assert.match(text, /11–18 Oct/);
  assert.match(text, /\*1\. n8n AI agents\*/);
  assert.match(text, /🔗 https:\/\/n8n\.io\/agents/);
  assert.match(text, /!digest (join|interests)/);
});

test('format: personal DM puts interest matches first with a star', () => {
  const text = renderPersonal(sampleDigest(), { name: 'Sam Smith', interests: ['design'] }, { timeZone: 'Europe/London' });
  const first = text.indexOf('Design systems');
  const second = text.indexOf('n8n AI agents');
  assert.ok(first > 0 && first < second);
  assert.match(text, /⭐ \*1\. Design systems at scale\*/);
  assert.match(text, /Hi Sam!/);
});

test('summary: hand-in summaries merge with ranked stats and are validated', () => {
  const base = sampleDigest();
  const merged = mergeSummary({ version: 1, intro: 'Agents week.', items: [{ id: base.items[0].id, title: 'n8n agents', summary: 'Build agents visually.' }] }, base);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].reactions, 1);
  assert.equal(merged.intro, 'Agents week.');
  assert.throws(() => mergeSummary({ items: [] }, base), /non-empty/);
  assert.throws(() => mergeSummary({ items: [{ summary: 'x' }] }, base), /title is required/);
  assert.deepEqual(extractJson('Sure!\n```json\n{"a":1}\n```'), { a: 1 });
});

test('quiet but useful messages are kept; reactions only change the order', async () => {
  const { rankMessages } = await import('../src/rank.js');
  const quiet = { MsgID: 'Q1', ChatJID: 'g@g.us', SenderJID: '447700000001@s.whatsapp.net', SenderName: 'Sam', Timestamp: '2026-10-15T10:00:00Z', Text: 'Heads up: the venue for Saturday moved to the library on King Street, doors open at ten' };
  const tiny = { ...quiet, MsgID: 'Q2', Text: 'ok thanks' };
  const { items } = rankMessages([quiet, tiny]);
  assert.deepEqual(items.map((i) => i.id), ['post:Q1', 'post:Q2'], 'a quiet chat lists even short messages');
  const busy = Array.from({ length: 4 }, (_, i) => ({ ...quiet, MsgID: `B${i}` }));
  assert.ok(!rankMessages([...busy, tiny]).items.some((i) => i.id === 'post:Q2'), 'short chit-chat is left out of a busy chat');
});

test('summarise everything: long chats become notes, then a summary of the notes', async () => {
  const { buildTranscript, summariseAll } = await import('../src/fullsummary.js');
  const base = { ChatJID: 'g@g.us', SenderName: 'Ali', SenderJID: '447700000002@s.whatsapp.net' };
  const msgs = [];
  for (let i = 0; i < 60; i++) msgs.push({ ...base, MsgID: `M${i}`, Timestamp: new Date(Date.UTC(2026, 9, 15, 0, i)).toISOString(), Text: `message number ${i} about topic ${i % 3} https://example.com/${i % 3}` });
  msgs.push({ ...base, MsgID: 'R1', Timestamp: '2026-10-15T02:00:00Z', ReactionToID: 'M1', ReactionEmoji: '🔥' });
  msgs.push({ ...base, MsgID: 'C1', Timestamp: '2026-10-15T02:01:00Z', Text: '!digest status' });
  const lines = buildTranscript(msgs, { timeZone: 'UTC' });
  assert.equal(lines.length, 60, 'reactions and commands are not lines');
  assert.match(lines[1], /\[🔥1\]$/);
  const calls = [];
  const ask = async (prompt, { json }) => {
    calls.push({ json, size: prompt.length });
    if (!json) return '- topic: notes';
    return JSON.stringify({ intro: 'All about topics.', items: [{ title: 'Topic 0', summary: 'Talked a lot.', urls: ['https://example.com/0', 'not a url'] }] });
  };
  const out = await summariseAll({ lines, group: 'G', days: 7, ask, maxChars: 1000 });
  assert.ok(calls.filter((c) => !c.json).length >= 2, 'the chat was split into parts');
  assert.equal(calls.at(-1).json, true);
  assert.equal(out.rounds, 1);
  assert.deepEqual(out.items[0].urls, ['https://example.com/0']);
  assert.equal(out.items[0].url, 'https://example.com/0');
});

test('anon: no names or @mentions reach the summary, the AI sees stand-in labels', () => {
  const t0 = Date.parse('2026-10-13T09:00:00Z');
  const at = (h) => new Date(t0 + h * 3600e3).toISOString();
  const rows = pseudonymise([
    msg({ MsgID: 'L1', Text: 'great read https://example.com/post', SenderName: 'Sam Jones', Timestamp: at(0) }),
    msg({ MsgID: 'R1', Text: 'agree with @447700900123, really useful', SenderJID: 'b@s.whatsapp.net', SenderName: 'Aisha', QuotedMsgID: 'L1', Timestamp: at(1) }),
    msg({ MsgID: 'TH', Text: 'Which vector DB are you all using?', SenderName: 'Sam Jones', Timestamp: at(2) }),
    msg({ MsgID: 'TH1', Text: 'pgvector has been solid for us', SenderJID: 'b@s.whatsapp.net', SenderName: 'Aisha', QuotedMsgID: 'TH', Timestamp: at(2.1) }),
    msg({ MsgID: 'TH2', Text: 'qdrant', SenderJID: 'c@s.whatsapp.net', SenderName: 'Tom', QuotedMsgID: 'TH', Timestamp: at(2.2) }),
  ]).messages;
  const lines = buildTranscript(rows, { timeZone: 'Europe/London' }).join('\n');
  assert.match(lines, /Member 1/);
  assert.doesNotMatch(lines, /Sam|Aisha|Tom|447700900123/);
  const ranked = rankMessages(rows);
  scrubNames(ranked.items);
  const digest = buildDigest(ranked, { group: { jid: 'g@g.us', name: 'Developer Bros', anon: true }, window: { start: '2026-10-11T08:00:00Z', end: '2026-10-18T08:00:00Z' }, topN: 5 });
  digest.items[0].summary = 'Member 2 agreed with Member 1. Member 3 said qdrant.';
  scrubNames(digest);
  const text = renderGroupPost(digest, { timeZone: 'Europe/London' });
  assert.doesNotMatch(text, /Sam|Aisha|Tom|447700900123|Member \d|👤/);
  assert.match(text, /A member agreed with a member\. A member said qdrant\./);
});

test('sent today: scheduled and manual sends count, other days and groups do not', async () => {
  const { sentTodayAt } = await import('../src/pipeline.js');
  const now = new Date('2026-10-18T20:00:00Z');
  const state = { posted: {
    'g1@g.us|2026-10-18': { at: '2026-10-18T08:00:00Z' },
    'manual|g1@g.us|1': { at: '2026-10-18T16:08:00Z' },
    'manual|g2@g.us|2': { at: '2026-10-17T16:08:00Z' },
  } };
  assert.equal(sentTodayAt(state, 'g1@g.us', 'Europe/London', now), '2026-10-18T16:08:00Z');
  assert.equal(sentTodayAt(state, 'g2@g.us', 'Europe/London', now), null);
  assert.equal(sentTodayAt(state, 'g3@g.us', 'Europe/London', now), null);
});

test('pseudonymise: the AI gets labels only; names typed in messages and @mentions are swapped; names come back after', () => {
  const t0 = Date.parse('2026-10-13T09:00:00Z');
  const at = (h) => new Date(t0 + h * 3600e3).toISOString();
  const { messages, names } = pseudonymise([
    msg({ MsgID: 'A', Text: 'Sam, can you book Sadaf?', SenderJID: '447700900111@s.whatsapp.net', SenderName: 'Aisha Khan', Timestamp: at(0) }),
    msg({ MsgID: 'B', Text: 'done, thanks Aisha. @447700900111 see you there', SenderJID: '447700900222@s.whatsapp.net', SenderName: 'Sam Jones', Timestamp: at(1) }),
    msg({ MsgID: 'C', Text: 'Will we meet at 1?', SenderJID: '447700900333@s.whatsapp.net', SenderName: 'Tom', Timestamp: at(2) }),
  ]);
  const lines = buildTranscript(messages, { timeZone: 'Europe/London' }).join('\n');
  assert.doesNotMatch(lines, /Aisha|Sam|Tom|Jones|Khan|447700900/);
  assert.match(lines, /Member 2, can you book Sadaf\?/);
  assert.match(lines, /thanks Member 1\. Member 1 see you there/);
  assert.match(lines, /Will we meet at 1\?/);
  const written = { items: [{ summary: 'Member 1 asked Member 2 to book Sadaf. Member 3 asked about the time.', sharedBy: 'Aisha Khan' }] };
  restoreNames(written, names);
  assert.equal(written.items[0].summary, 'Aisha Khan asked Sam Jones to book Sadaf. Tom asked about the time.');
  assert.equal(written.items[0].sharedBy, 'Aisha Khan');
});

test('anon: several unnamed people read as a count, not "a member and a member"', () => {
  const d = { items: [{ summary: 'Member 1 and Member 2 shared photos. Then Member 1, Member 2 and Member 3 left.' }] };
  scrubNames(d);
  assert.equal(d.items[0].summary, 'Two members shared photos. Then three members left.');
});
