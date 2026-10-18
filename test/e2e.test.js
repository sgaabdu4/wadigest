// End-to-end through the real wacli wrapper against the fake wacli binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, msg, reaction, GROUP, noFetch } from './helpers.js';
import { ensureConfig, saveConfig, loadState, saveState, loadConfig, groupConfig, newGroup, paths } from '../src/config.js';
import { Wacli } from '../src/wacli.js';
import { prepareDigest, deliver, runGroupNow } from '../src/pipeline.js';
import { processCommands, maybeRunDue } from '../src/daemon.js';

const maybeRunWeekly = async (a) => (await maybeRunDue(a))[0];
import { loadMembers, saveMembers } from '../src/members.js';
import { rollingWindow } from '../src/schedule.js';
import fs from 'node:fs';
import path from 'node:path';

function setupCfg(over = {}) {
  const cfg = ensureConfig();
  cfg.groups = [newGroup({ jid: GROUP, name: 'Developer Bros' }, { addedAt: over.installedAt || cfg.installedAt })];
  cfg.linkTitles = false;
  cfg.video.enabled = 'off';
  cfg.dms.minDelaySec = 0;
  cfg.dms.maxDelaySec = 0;
  Object.assign(cfg, over);
  saveConfig(cfg);
  return groupConfig(cfg, cfg.groups[0]);
}

function weekOfMessages(n = 120) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(msg({ MsgID: `W${i}`, Text: i % 10 === 0 ? `link ${i} https://example.com/tool-${i}` : `chat ${i}`, Timestamp: new Date(Date.now() - (i + 1) * 3600e3).toISOString() }));
  }
  rows.push(reaction('W10', 'a@s.whatsapp.net', '🔥'), reaction('W10', 'b@s.whatsapp.net', '🔥'));
  rows.push(msg({ MsgID: 'OLD', Text: 'old https://old.example', Timestamp: new Date(Date.now() - 9 * 864e5).toISOString() }));
  rows.push(msg({ MsgID: 'OTHER', ChatJID: '120363000000000002@g.us', Text: 'family https://family.example' }));
  return rows;
}

test('preview pipeline: pages through wacli, ranks, stays inside the group and the window', async () => {
  sandbox({ messages: weekOfMessages() });
  const cfg = setupCfg();
  const state = loadState();
  const wacli = new Wacli(cfg);
  const { digest, messages } = await prepareDigest({ cfg, state, wacli, window: rollingWindow(), fetchImpl: noFetch });
  assert.equal(messages, 122); // 120 + 2 reactions; old and other-group excluded
  assert.equal(digest.items.length, 5);
  assert.equal(digest.items[0].url, 'https://example.com/tool-10'); // the reacted one
  assert.ok(!digest.items.some((i) => /old|family/.test(i.url)));
});

test('deliver: posts once to the group, DMs active members except self, records state', async () => {
  const sb = sandbox({ messages: weekOfMessages(30) });
  const cfg = setupCfg();
  saveMembers([
    { jid: '447700000001@s.whatsapp.net', name: 'Sam', interests: ['tool-20'], active: true },
    { jid: '447700000002@s.whatsapp.net', name: 'Ali', interests: [], active: false },
    { jid: '447000000001@s.whatsapp.net', name: 'Me', interests: [], active: true }, // linked number
  ]);
  const state = loadState();
  const wacli = new Wacli(cfg);
  const { digest } = await prepareDigest({ cfg, state, wacli, window: rollingWindow(), fetchImpl: noFetch });
  const res = await deliver({ cfg, state, wacli, digest, key: 'k1' });
  const all = sb.sent();
  const sent = all.filter((x) => x.message);
  assert.ok(all.some((x) => x.pin === sent[0].id && x.duration === '7d'), 'group post is pinned for 7 days');
  assert.equal(res.pinned, true);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, GROUP);
  assert.match(sent[0].message, /^📬 \*Weekly digest · Developer Bros\*/);
  assert.equal(sent[1].to, '447700000001@s.whatsapp.net');
  assert.match(sent[1].message, /⭐/);
  assert.equal(res.skipped.length, 1);
  assert.ok(loadState().posted.k1.groupMessageId.startsWith('SENT'));
});

test('DMs go to every group member by default, minus opt-outs and the linked number', async () => {
  const sb = sandbox({
    messages: weekOfMessages(10),
    participants: [
      { group_jid: GROUP, user_jid: '447700000011@s.whatsapp.net', role: 'admin' },
      { group_jid: GROUP, user_jid: '99887766@lid', role: '' },
      { group_jid: GROUP, user_jid: '447700000012@s.whatsapp.net', role: '' },
      { group_jid: GROUP, user_jid: '447000000001@s.whatsapp.net', role: 'superadmin' },
    ],
  });
  const cfg = setupCfg();
  saveMembers([
    { jid: '447700000011@s.whatsapp.net', name: 'Ann', interests: ['tool-0'], active: true },
    { jid: '447700000012@s.whatsapp.net', name: 'Bo', interests: [], active: false },
  ]);
  const state = loadState();
  const wacli = new Wacli(cfg);
  const { digest } = await prepareDigest({ cfg, state, wacli, window: rollingWindow(), fetchImpl: noFetch });
  await deliver({ cfg, state, wacli, digest, key: 'k2' });
  const dms = sb.sent().filter((x) => x.message && x.to !== GROUP).map((x) => x.to);
  assert.deepEqual(dms.sort(), ['447700000011@s.whatsapp.net', '99887766@lid']);
  assert.match(sb.sent().find((x) => x.to === GROUP).message, /Everyone here gets a copy by DM/);
});

test('weekly run: due slot posts, second tick does not post again; failures retry later', async () => {
  const sb = sandbox({ messages: weekOfMessages(20) });
  const cfg = setupCfg({ installedAt: '2020-01-01T00:00:00Z' });
  const wacli = new Wacli(cfg);
  const now = new Date();
  // schedule a slot 10 minutes ago in UTC
  const ten = new Date(now.getTime() - 10 * 60e3);
  cfg.schedule = { day: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][ten.getUTCDay()], time: `${String(ten.getUTCHours()).padStart(2, '0')}:${String(ten.getUTCMinutes()).padStart(2, '0')}`, timezone: 'UTC' };
  saveConfig(cfg);

  process.env.FAKE_WACLI_FAIL = 'send text';
  let state = loadState();
  let r = await maybeRunWeekly({ cfg, state, wacli, now });
  assert.equal(r.ran, false);
  assert.equal(loadState().attempts[r.key].count, 1);
  // immediately again: waits for the retry gap
  r = await maybeRunWeekly({ cfg, state: loadState(), wacli, now });
  assert.equal(r.due, false);

  delete process.env.FAKE_WACLI_FAIL;
  const later = new Date(now.getTime() + 31 * 60e3);
  r = await maybeRunWeekly({ cfg, state: loadState(), wacli, now: later });
  assert.equal(r.ran, true);
  r = await maybeRunWeekly({ cfg, state: loadState(), wacli, now: new Date(later.getTime() + 3600e3) });
  assert.equal(r.due, false);
  assert.equal(sb.sent().filter((s) => s.to === GROUP).length, 1);
});

test('commands: !digest join in the group opts in and replies by DM; handled once', async () => {
  const t = new Date(Date.now() - 60e3).toISOString();
  const sb = sandbox({
    messages: [
      msg({ MsgID: 'C1', Text: '!digest join agents, n8n', SenderJID: '447700000009@s.whatsapp.net', SenderName: 'Zak', Timestamp: t }),
      msg({ MsgID: 'C2', Text: '!digest status', ChatJID: '447700000009@s.whatsapp.net', SenderJID: '447700000009@s.whatsapp.net', SenderName: 'Zak', Timestamp: t }),
      msg({ MsgID: 'C3', Text: '!digest join x', ChatJID: '120363000000000002@g.us', Timestamp: t }), // other group: ignored
      msg({ MsgID: 'C4', Text: '!digest join', FromMe: true, Timestamp: t }), // ourselves: ignored
    ],
  });
  const cfg = setupCfg({ installedAt: '2020-01-01T00:00:00Z' });
  const wacli = new Wacli(cfg);
  const state = loadState();
  state.commandsCheckedAt = new Date(Date.now() - 10 * 60e3).toISOString();
  const n = await processCommands({ cfg, state, wacli });
  saveState(state);
  assert.equal(n, 2);
  const members = loadMembers();
  assert.equal(members.length, 1);
  assert.deepEqual(members[0].interests, ['agents', 'n8n']);
  const sent = sb.sent();
  assert.equal(sent.length, 2);
  assert.ok(sent.every((s) => s.to === '447700000009@s.whatsapp.net'));
  assert.match(sent[0].message, /You're in/);
  assert.match(sent[1].message, /signed up/);
  // second pass: nothing new
  const again = await processCommands({ cfg, state: loadState(), wacli });
  assert.equal(again, 0);
});

test('summary hand-off: run with a Claude-written summary file', async () => {
  const sb = sandbox({ messages: weekOfMessages(20) });
  const cfg = setupCfg();
  const wacli = new Wacli(cfg);
  const file = path.join(sb.home, 'summary.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, intro: 'Big week for tools.', items: [{ id: 'link:https://example.com/tool-10', title: 'Tool 10', summary: 'It does things.', url: 'https://example.com/tool-10' }] }));
  const state = loadState();
  const { digest } = await prepareDigest({ cfg, state, wacli, window: rollingWindow(), summaryFile: file, fetchImpl: noFetch });
  assert.equal(digest.items.length, 1);
  assert.equal(digest.items[0].reactions, 2);
  await deliver({ cfg, state, wacli, digest, key: 'k', noDms: true });
  assert.match(sb.sent()[0].message, /Big week for tools\.[\s\S]*\*1\. Tool 10\*\nIt does things\./);
});

test('wacli errors surface with the wacli message', async () => {
  sandbox({});
  const cfg = setupCfg();
  process.env.FAKE_WACLI_FAIL = 'messages list';
  await assert.rejects(new Wacli(cfg).listMessages({ chat: GROUP }), /simulated failure/);
  delete process.env.FAKE_WACLI_FAIL;
});

test('two groups: each gets its own digest, with its own post / pin / DM switches', async () => {
  const OTHER = '120363000000000002@g.us';
  const rows = [
    msg({ MsgID: 'A1', Text: 'dev link https://dev.example', Timestamp: new Date(Date.now() - 3600e3).toISOString() }),
    msg({ MsgID: 'B1', ChatJID: OTHER, ChatName: 'Family', Text: 'family link https://family.example', Timestamp: new Date(Date.now() - 3600e3).toISOString() }),
  ];
  const sb = sandbox({
    messages: rows,
    participants: [{ group_jid: OTHER, user_jid: '447700000021@s.whatsapp.net', role: '' }],
  });
  const base = ensureConfig();
  base.groups = [
    newGroup({ jid: GROUP, name: 'Developer Bros' }, { dm: false }),
    newGroup({ jid: OTHER, name: 'Family' }, { post: true, pin: false, dm: true }),
  ];
  Object.assign(base, { linkTitles: false });
  base.video.enabled = 'off';
  base.dms.minDelaySec = 0;
  base.dms.maxDelaySec = 0;
  saveConfig(base);
  const cfg = loadConfig();
  const state = loadState();
  const wacli = new Wacli(cfg);
  for (const g of cfg.groups) await runGroupNow({ cfg, group: g, state, wacli });
  const sent = sb.sent();
  const devPost = sent.find((x) => x.to === GROUP);
  const famPost = sent.find((x) => x.to === OTHER);
  assert.match(devPost.message, /dev\.example/);
  assert.doesNotMatch(devPost.message, /family\.example/);
  assert.match(famPost.message, /family\.example/);
  assert.ok(sent.some((x) => x.pin && x.chat === GROUP), 'Developer Bros is pinned');
  assert.ok(!sent.some((x) => x.pin && x.chat === OTHER), 'Family is not pinned');
  const dms = sent.filter((x) => x.to && !x.to.endsWith('@g.us'));
  assert.deepEqual(dms.map((x) => x.to), ['447700000021@s.whatsapp.net'], 'only Family members get DMs');
});

test('an old single-group config is read as a one-group list', () => {
  sandbox();
  fs.mkdirSync(path.dirname(paths().config), { recursive: true });
  fs.writeFileSync(paths().config, JSON.stringify({ group: { jid: GROUP, name: 'Developer Bros' }, installedAt: '2026-01-01T00:00:00Z', dms: { enabled: false } }));
  const cfg = loadConfig();
  assert.equal(cfg.group, undefined);
  assert.equal(cfg.groups.length, 1);
  assert.equal(cfg.groups[0].jid, GROUP);
  assert.equal(cfg.groups[0].dm, false);
  assert.equal(cfg.groups[0].addedAt, '2026-01-01T00:00:00Z');
});
