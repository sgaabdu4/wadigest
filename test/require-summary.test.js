import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, msg, GROUP } from './helpers.js';
import { ensureConfig, loadState, newGroup, paths } from '../src/config.js';
import { Wacli } from '../src/wacli.js';
import { runGroupNow } from '../src/pipeline.js';

function setup(mode, count = 4) {
  const sb = sandbox({ messages: Array.from({ length: count }, (_, i) => msg({ Text: `A useful discussion about project ${i}.` })) });
  const cfg = ensureConfig();
  cfg.groups = [newGroup({ jid: GROUP, name: 'Developer Bros' })];
  cfg.mode = mode;
  cfg.linkTitles = false;
  cfg.video.enabled = 'off';
  cfg.chatgpt = { command: path.join(sb.home, 'missing-codex') };
  cfg.claude = { command: path.join(sb.home, 'missing-claude') };
  const previous = { marker: 'previous successful digest' };
  fs.writeFileSync(paths().lastDigest, JSON.stringify(previous));
  const state = loadState();
  return { sb, cfg, previous, state, run: () => runGroupNow({ cfg, group: cfg.groups[0], state, wacli: new Wacli(cfg) }) };
}

function untouched(ctx) {
  assert.deepEqual(ctx.sb.sent(), []);
  assert.deepEqual(ctx.state.posted, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(paths().lastDigest, 'utf8')), ctx.previous);
}

function fakeCodex(ctx, t, output) {
  const file = fileURLToPath(new URL('./fixtures/fake-codex.js', import.meta.url));
  fs.chmodSync(file, 0o755);
  ctx.cfg.chatgpt.command = file;
  process.env.FAKE_CODEX_OUTPUT = output;
  t.after(() => { delete process.env.FAKE_CODEX_OUTPUT; });
}

for (const output of ['not JSON', '{"items":[]}', '{"items":[{"title":"Topic","summary":""}]}']) {
  test(`unusable AI output ${output} does not post excerpts`, async (t) => {
    const ctx = setup('chatgpt');
    fakeCodex(ctx, t, output);
    await assert.rejects(ctx.run, /write-up failed; no digest was sent/);
    untouched(ctx);
  });
}

test('a valid AI summary still reaches the group', async (t) => {
  const ctx = setup('chatgpt');
  fakeCodex(ctx, t, JSON.stringify({ intro: 'Members discussed their projects.', items: [{ title: 'Project work', summary: 'Members shared project updates.', urls: [] }] }));
  await ctx.run();
  const posts = ctx.sb.sent().filter(item => item.message);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].to, GROUP);
  assert.match(posts[0].message, /Members shared project updates/);
  assert.doesNotMatch(posts[0].message, /A useful discussion about project/);
});

for (const mode of ['local', 'chatgpt', 'claude']) {
  test(`${mode} failure does not post excerpts or send DMs`, async (t) => {
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    t.after(() => { if (key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = key; });
    const ctx = setup(mode);
    await assert.rejects(ctx.run, /write-up failed; no digest was sent/);
    untouched(ctx);
  });
}

for (const count of [0, 1, 2]) {
  test(`AI mode with ${count} messages does not post excerpts`, async () => {
    const ctx = setup('chatgpt', count);
    await assert.rejects(ctx.run, /too few to summarise; no digest was sent/);
    untouched(ctx);
  });
}

for (const kind of ['missing', 'invalid', 'stale']) {
  test(`${kind} configured summary file does not post excerpts`, async () => {
    const ctx = setup('summary-file');
    if (kind !== 'missing') {
      const file = path.join(ctx.sb.home, 'summary.json');
      fs.writeFileSync(file, '{invalid');
      if (kind === 'stale') fs.utimesSync(file, new Date(0), new Date(0));
      ctx.cfg.summary = { path: file };
    }
    await assert.rejects(ctx.run, /no digest was sent/);
    untouched(ctx);
  });
}
