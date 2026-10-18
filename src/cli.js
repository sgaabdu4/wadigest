// wadigest command line.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  groupConfig,
  loadConfig, saveConfig, ensureConfig, loadState, saveState, setConfigValue, paths, loadSecrets, saveSecrets, DAYS,
} from './config.js';
import { Wacli } from './wacli.js';
import { prepareDigest, deliver } from './pipeline.js';
import { renderGroupPost, renderPersonal } from './format.js';
import { exportForSummariser, summariserPrompt } from './summary.js';
import { latestSlot, nextSlot, weekKey, windowFor, rollingWindow, readDays, describeSchedule, applySchedule } from './schedule.js';
import { loadMembers, saveMembers, upsertMember, findMember } from './members.js';
import { runDaemon } from './daemon.js';
import { installService, uninstallService, serviceStatus, stopServiceIfRunning } from './service.js';
import { detectVideoTools } from './video.js';
import { isGroupJid, normalizePhone, parseInterests } from './util.js';
import { findGroups } from './groups.js';
import { runSetupUI } from './webui.js';
import { hasUI, detectClaude, installLocalAI, installVideo, localStatus } from './setup-actions.js';
import { setGroups } from './reset.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const HELP = `wadigest ${VERSION}: the best of your WhatsApp groups, in one message (built on wacli)

  wadigest                       open the setup page (or the setup questions, if there's no screen)

Setup
  wadigest setup [--terminal]    connect WhatsApp, pick groups, choose when it sends, start it
  wadigest link [--phone +44…]   connect (or reconnect) WhatsApp
  wadigest groups [search]       list your WhatsApp groups
  wadigest doctor                check everything is working

Sending  (add --group "Name" to act on one group only)
  wadigest preview               build the summary and print it. Sends nothing.
  wadigest run [--yes] [--no-dms] [--no-group]
                                 send it now (asks first unless --yes)
  wadigest status                groups, schedule, next send, last send

Your own summary  (Claude or anything else)
  wadigest export [--out week.json] [--prompt] [--group "Name"]
  wadigest run --summary summary.json --group "Name"

Groups
  wadigest config add-group "Name"     wadigest config remove-group "Name"
  wadigest config group "Name" post|pin|dm on|off

Settings
  wadigest config                show all settings
  wadigest config set KEY VALUE  schedule.everyDays 7 · schedule.day sunday · schedule.time 09:00
                                 schedule.readDays 0 (0 = same as everyDays) · schedule.timezone Europe/London
                                 mode digest|local|claude|summary-file · topN 5 · dms.audience everyone|opted-in
                                 pin.duration 24h|7d|30d · video.enabled auto|on|off
  wadigest config set-key        save an Anthropic API key (for mode claude without Claude Code)

Members  (they sign themselves up with "!digest join" or the Invite QR code)
  wadigest members | members add --phone 4477… [--name Sam] [--interests "agents, n8n"] | members remove --phone 4477…

Background
  wadigest service install|uninstall|status
  wadigest daemon                run it in this terminal instead
`;

/** Line-queue prompt: works in a terminal and with piped input (lines aren't lost). */
function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const lines = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : lines.push(l)));
  rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });
  return {
    question(q) {
      process.stdout.write(q);
      if (lines.length) { const l = lines.shift(); if (!process.stdin.isTTY) process.stdout.write(l + '\n'); return Promise.resolve(l); }
      if (closed) return Promise.reject(new Error('input ended'));
      return new Promise((res, rej) => waiters.push((l) => (l === null ? rej(new Error('input ended')) : res(l))));
    },
    pause() { rl.pause(); },
    resume() { rl.resume(); },
    close() { rl.close(); },
  };
}

async function ask(rl, q, def = '') {
  const a = (await rl.question(def ? `${q} [${def}] ` : `${q} `)).trim();
  return a || def;
}

async function resolveGroup(wacli, query) {
  let groups = await wacli.groups('');
  let pick = findGroups(groups, query);
  if (!pick.length) {
    try { await wacli.refreshGroups(); groups = await wacli.groups(''); pick = findGroups(groups, query); } catch { /* daemon holds the lock; use what's stored */ }
  }
  if (pick.length === 1) return { jid: pick[0].jid, name: pick[0].name };
  if (!pick.length) throw new Error(`No group chat called "${query}" exists on this WhatsApp account. Run \`wadigest groups\` to see the groups it's in.`);
  throw new Error(`"${query}" matches ${pick.length} groups:\n${pick.map((g) => `  ${g.name}  ${g.jid}`).join('\n')}\nUse the ID: wadigest config set group <ID>`);
}

function fmtWhen(d, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
}

// ---------- commands ----------

async function cmdLink(cfg, flags) {
  const wacli = new Wacli(cfg);
  const stopped = stopServiceIfRunning();
  if (stopped) console.log('Paused the background service while linking.');
  let phone = flags.phone && flags.phone !== true ? normalizePhone(flags.phone) : '';
  console.log(phone
    ? '\nAn 8-character code will appear below. On your phone: WhatsApp → Settings → Linked devices → Link a device → "Link with phone number instead" → type the code.\n'
    : '\nA QR code will appear below. On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan it.\n');
  await wacli.link({ phone });
  const st = await wacli.authStatus();
  if (!st.authenticated) throw new Error('Linking did not complete. Run `wadigest link --phone +44…` to try again.');
  console.log(`\n✅ Linked as +${st.phone}. WhatsApp is now sending recent history (this can take a few minutes).`);
  if (stopped) installService(cfg);
  return st;
}

async function cmdGroups(cfg, query) {
  const wacli = new Wacli(cfg);
  let groups = await wacli.groups(query || '');
  if (!groups.length && !query) {
    console.log('No groups stored yet, fetching them from WhatsApp…');
    try { await wacli.refreshGroups(); } catch (e) { console.log(`(refresh failed: ${e.message})`); }
    groups = await wacli.groups('');
  }
  if (!groups.length) return console.log(query ? `No groups matching "${query}".` : 'No groups found.');
  for (const g of groups) console.log(`${g.name || '(no name)'}\n    ${g.jid}${cfg.groups.some((x) => x.jid === g.jid) ? '   ← digest group' : ''}`);
}

async function cmdSetup(flags) {
  const cfg = ensureConfig();
  const wacli = new Wacli(cfg);
  if (stopServiceIfRunning()) console.log('(Paused the background service during setup.)');
  const rl = makePrompter();
  try {
    console.log(`\n=== wadigest setup ===\n`);
    // 0. wacli present
    try {
      console.log(`wacli: ${await wacli.version()}`);
    } catch (e) {
      throw new Error(`${e.message}\nRun scripts/install.sh first (it installs wacli).`);
    }

    // 1. Link
    let st = await wacli.authStatus().catch(() => ({ authenticated: false }));
    if (st.authenticated && !flags.relink) {
      console.log(`Step 1/5 · WhatsApp: linked as +${st.phone} ✅`);
    } else {
      console.log('\nStep 1/5 · Link WhatsApp');
      console.log('Use the WhatsApp account that is in the group. wadigest posts the digest from this number.');
      const phone = flags.phone && flags.phone !== true ? flags.phone : await ask(rl, 'Your WhatsApp number with country code (e.g. +44 7700 900123), or blank for a QR code:');
      rl.pause();
      st = await cmdLink(cfg, { phone });
      rl.resume();
    }

    // 2. Group
    console.log('\nStep 2/5 · Which group chat?');
    let groups = await wacli.groups('');
    let refreshed = false;
    const refresh = async () => {
      console.log('Fetching your group list from WhatsApp…');
      try { await wacli.refreshGroups(); } catch (e) { console.log(`(couldn't refresh: ${e.message})`); }
      groups = await wacli.groups('');
      refreshed = true;
    };
    if (!groups.length) await refresh();
    console.log(`This WhatsApp (+${st.phone || '?'}) is in ${groups.length} group chat${groups.length === 1 ? '' : 's'}.`);
    const yes = async (q, def = 'y') => /^y/i.test(await ask(rl, `${q} (y/n)`, def));
    let chosen = [];
    let preset = flags.group && flags.group !== true ? String(flags.group) : '';
    if (cfg.groups.length && !preset && await yes(`Keep using ${cfg.groups.map((g) => `"${g.name}"`).join(', ')}?`)) chosen = [...cfg.groups];
    while (!chosen.length || (!preset && await yes('Add another group?', 'n'))) {
      const q = preset || await ask(rl, 'Type the name of a group chat:');
      preset = '';
      if (!q) continue;
      let matches = findGroups(groups, q);
      if (!matches.length && !refreshed) { await refresh(); matches = findGroups(groups, q); }
      if (!matches.length) {
        console.log(`✖ No group chat called "${q}" exists on this WhatsApp account (+${st.phone || '?'}). Check the spelling, or make sure this number is a member of the group.`);
        continue;
      }
      let g = matches[0];
      if (matches.length > 1) {
        console.log(`"${q}" matches ${matches.length} groups:`);
        matches.slice(0, 20).forEach((m, i) => console.log(`  ${i + 1}. ${m.name}`));
        const n = Number(await ask(rl, 'Number (or 0 to search again):', '1'));
        if (!(n >= 1 && n <= Math.min(matches.length, 20))) continue;
        g = matches[n - 1];
      } else if (!await yes(`Found "${g.name}". Use it?`)) continue;
      if (!chosen.some((c) => c.jid === g.jid)) chosen.push({ jid: g.jid, name: g.name });
    }
    for (const g of chosen) {
      const old = cfg.groups.find((x) => x.jid === g.jid) || {};
      g.post = await yes(`${g.name}: post the digest in the group?`, old.post === false ? 'n' : 'y');
      g.pin = g.post && await yes(`${g.name}: pin it?`, old.pin === false ? 'n' : 'y');
      g.dm = await yes(`${g.name}: send it to each member by DM?`, old.dm === false ? 'n' : 'y');
    }
    setGroups(cfg, chosen);
    Object.assign(cfg, loadConfig());
    console.log(`✅ Using ${chosen.map((g) => `"${g.name}"`).join(', ')}. Saved by ID, so renaming a group won't break anything.`);

    // 3. Summary style
    console.log('\nStep 3/5 · How should it write the digest?');
    const [claude, local] = await Promise.all([detectClaude(), localStatus(cfg)]);
    console.log('  1. Simple summary: ranked by reactions and replies, no AI, nothing to install (recommended)');
    console.log(`  2. Local AI: runs on this computer, private, about 1.3 GB to download${local.modelReady ? ' (already installed ✓)' : ''}`);
    console.log(`  3. Claude: best writing, the week's top items go to Anthropic${claude.cli ? ' (Claude Code found ✓)' : ''}`);
    const current = { digest: '1', local: '2', claude: '3' }[cfg.mode] || '1';
    let pickMode = '';
    while (!['1', '2', '3'].includes(pickMode)) pickMode = await ask(rl, 'Pick 1, 2 or 3:', current);
    const mode = { 1: 'digest', 2: 'local', 3: 'claude' }[pickMode];
    const onLog = (l) => console.log(`   ${l}`);
    if (mode === 'local' && !local.modelReady) {
      try { await installLocalAI({ model: cfg.local?.model, onLog }); } catch (e) { console.log(`✖ ${e.message}\n  Using the simple summary for now. Run \`wadigest setup\` again to retry.`); }
    }
    if (mode === 'claude' && !claude.cli && !loadSecrets().anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
      const key = await ask(rl, 'Claude Code is not installed here. Paste an Anthropic API key (sk-ant-…), or leave blank for the simple summary:');
      if (key.startsWith('sk-')) saveSecrets({ ...loadSecrets(), anthropicApiKey: key });
    }
    const localOk = mode !== 'local' || (await localStatus(cfg)).modelReady;
    const claudeOk = mode !== 'claude' || claude.cli || !!loadSecrets().anthropicApiKey || !!process.env.ANTHROPIC_API_KEY;
    cfg.mode = localOk && claudeOk ? mode : 'digest';
    if (process.platform !== 'win32') {
      const vid = await ask(rl, `Also transcribe videos posted in the group? On this computer, ~150 MB download. (y/n)`, local.video ? 'y' : 'n');
      if (/^y/i.test(vid)) {
        try { await installVideo({ onLog }); cfg.video.enabled = 'auto'; } catch (e) { console.log(`✖ ${e.message}`); }
      } else cfg.video.enabled = 'off';
    }
    saveConfig(cfg);

    // 4. Schedule + DMs
    console.log('\nStep 4/5 · When and who');
    const every = await ask(rl, 'How often, in days? (1 = every day, 7 = every week, 14 = every 2 weeks)', String(cfg.schedule.everyDays || 7));
    const day = Number(every) === 1 ? cfg.schedule.day : await ask(rl, Number(every) === 7 ? 'Day:' : 'Day of the first one:', cfg.schedule.day);
    const time = await ask(rl, 'Time (24h):', cfg.schedule.time);
    const tz = await ask(rl, 'Timezone:', cfg.schedule.timezone);
    applySchedule(cfg, { everyDays: every, day, time, timezone: tz });
    console.log('Who gets a copy by DM, in the groups where DMs are on?  1. Everyone in the group (recommended)  2. Only people who send !digest join');
    const curAud = { everyone: '1', 'opted-in': '2' }[cfg.dms.audience] || '1';
    const aud = { 1: 'everyone', 2: 'opted-in' }[await ask(rl, 'Pick 1 or 2:', curAud)] || 'everyone';
    setConfigValue(cfg, 'dms.audience', aud);
    cfg.dms.enabled = true;
    saveConfig(cfg);
    console.log(`${describeSchedule(cfg.schedule)} (${cfg.schedule.timezone}), covering the previous ${readDays(cfg.schedule)} days.`);

    // 5. Service
    console.log('\nStep 5/5 · Start');
    cfg.setupDone = true;
    saveConfig(cfg);
    try { console.log(`Started in the background: ${installService(cfg)}`); } catch (e) { console.log(`Couldn't start it in the background: ${e.message}.`); }
    const pin = await wacli.supportsPin();
    console.log(`\n✅ All set. Next digest: ${fmtWhen(nextSlot(new Date(), cfg.schedule), cfg.schedule.timezone)}.${pin ? '' : ' (Pinning needs the wadigest build of wacli: re-run the installer.)'}`);
    console.log(`   wadigest preview    see the digest now (sends nothing)\n   wadigest run        send it now\n   wadigest${hasUI() ? '            open the control panel' : ' setup      change the settings'}\n`);
  } finally {
    rl.close();
  }
}

/** The groups a command acts on: all of them, or the one named with --group. */
function pickGroups(cfg, flags) {
  if (!cfg.groups.length) throw new Error('No group chosen yet. Run `wadigest setup`.');
  if (!flags.group || flags.group === true) return cfg.groups;
  const hit = findGroups(cfg.groups, String(flags.group));
  if (!hit.length) throw new Error(`"${flags.group}" isn't one of your digest groups: ${cfg.groups.map((g) => g.name).join(', ')}`);
  return hit;
}

function switches(g) {
  return [g.post !== false && 'post', g.post !== false && g.pin !== false && 'pin', g.dm !== false && 'DM members'].filter(Boolean).join(', ') || 'nothing switched on';
}

async function buildNow(cfg, flags) {
  const state = loadState();
  const wacli = new Wacli(cfg);
  const window = flags.week === 'last'
    ? windowFor(latestSlot(new Date(), cfg.schedule), cfg.schedule.timezone, readDays(cfg.schedule))
    : rollingWindow(new Date(), readDays(cfg.schedule));
  const summaryFile = flags.summary && flags.summary !== true ? path.resolve(flags.summary) : undefined;
  const res = await prepareDigest({ cfg, state, wacli, window, summaryFile, videos: flags['no-video'] ? false : true });
  saveState(state);
  return { ...res, state, wacli, window };
}

async function cmdPreview(base, flags) {
  for (const g of pickGroups(base, flags)) await previewOne(groupConfig(base, g), flags);
}

async function previewOne(cfg, flags) {
  const { digest, messages, notes } = await buildNow(cfg, flags);
  if (flags.json) return console.log(JSON.stringify(digest, null, 2));
  console.log(`\n${messages} messages read from ${cfg.group.name} · ${digest.items.length} item${digest.items.length === 1 ? '' : 's'} · written by ${digest.writtenBy}`);
  notes.forEach((n) => console.log(`note: ${n}`));
  console.log('\n────────── group post ──────────\n');
  console.log(renderGroupPost(digest, { timeZone: cfg.schedule.timezone, audience: cfg.dms?.enabled === false ? 'off' : cfg.dms?.audience }));
  const members = loadMembers().filter((m) => m.active);
  const sample = members[0] || { name: 'Sam', interests: ['agents', 'n8n'] };
  console.log(`\n────────── personal DM (${members[0] ? members[0].name || members[0].jid : 'example member: agents, n8n'}) ──────────\n`);
  console.log(renderPersonal(digest, sample, { timeZone: cfg.schedule.timezone }));
  console.log(`\n(DMs: ${cfg.dms.enabled ? cfg.dms.audience : 'off'} for this group.) Nothing was sent.`);
}

async function cmdRun(base, flags) {
  const groups = pickGroups(base, flags);
  if (flags.summary && groups.length > 1) throw new Error(`A summary file is for one group. Add --group, e.g. --group "${groups[0].name}"`);
  if (!flags.yes) {
    console.log('Send the digest now to:');
    groups.forEach((g) => console.log(`  ${g.name}: ${switches(g)}`));
    const rl = makePrompter();
    const a = await ask(rl, 'Send now? (y/n)', 'n');
    rl.close();
    if (!/^y/i.test(a)) return console.log('Cancelled, nothing sent.');
  }
  for (const g of groups) await runOne(groupConfig(base, g), flags);
}

async function runOne(cfg, flags) {
  const { digest, messages, notes, state, wacli } = await buildNow(cfg, flags);
  notes.forEach((n) => console.log(`note: ${n}`));
  console.log(`\n${cfg.group.name}: ${messages} messages → ${digest.items.length} item${digest.items.length === 1 ? '' : 's'}`);
  const noGroup = !!flags['no-group'] || !cfg.post;
  const key = noGroup ? null : `manual|${cfg.group.jid}|${weekKey(new Date(), cfg.schedule.timezone)}-${Date.now()}`;
  const pauseSync = async (fn) => {
    const was = stopServiceIfRunning();
    try { return await fn(); } finally { if (was) installService(cfg); }
  };
  const res = await deliver({
    cfg, state, wacli, digest, key, noGroup, noDms: !!flags['no-dms'], pauseSync,
    onDm: (m, ok, err) => console.log(`  DM ${ok ? '✓' : '✗'} ${m.name || m.jid}${err ? `: ${err.message}` : ''}`),
  });
  if (res.group) console.log(`✅ Posted in ${cfg.group.name}${res.pinned ? ' and pinned it' : ` (not pinned: ${res.pinNote || 'pinning is off'})`}`);
  if (res.skipped.length) res.skipped.forEach((s) => console.log(`  skipped ${s.jid}: ${s.why}`));
  console.log(`DMs: ${res.dms.filter((d) => d.ok).length} sent, ${res.dms.filter((d) => !d.ok).length} failed.`);
}

async function cmdExport(base, flags) {
  const groups = pickGroups(base, flags);
  if (groups.length > 1) throw new Error(`Pick one group with --group, e.g. --group "${groups[0].name}"`);
  const cfg = groupConfig(base, groups[0]);
  const { digest, transcript } = await buildNow({ ...cfg, mode: 'digest' }, flags);
  const exported = exportForSummariser(digest, transcript);
  const json = JSON.stringify(exported, null, 2);
  if (flags.out && flags.out !== true) {
    fs.writeFileSync(flags.out, json + '\n');
    console.log(`Wrote ${transcript.length} messages and ${exported.candidates.length} links/threads to ${flags.out}`);
  } else if (!flags.prompt) console.log(json);
  if (flags.prompt) console.log(summariserPrompt(exported));
}

async function cmdStatus(cfg) {
  const wacli = new Wacli(cfg);
  const state = loadState();
  const tz = cfg.schedule.timezone;
  let auth = 'unknown';
  try {
    const st = await wacli.authStatus();
    auth = st.authenticated ? `linked as +${st.phone}` : 'NOT linked (run: wadigest link --phone +44…)';
  } catch (e) { auth = `error: ${e.message}`; }
  const now = new Date();
  const last = latestSlot(now, cfg.schedule);
  const next = nextSlot(now, cfg.schedule);
  const members = loadMembers();
  const lastPost = Object.entries(state.posted).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))[0];
  console.log(`WhatsApp:  ${auth}`);
  if (!cfg.groups.length) console.log('Groups:    none chosen (run: wadigest setup)');
  for (const g of cfg.groups) {
    const done = state.posted[`${g.jid}|${weekKey(last, tz)}`] || state.posted[weekKey(last, tz)] || last.getTime() < Date.parse(g.addedAt || cfg.installedAt);
    console.log(`Group:     ${g.name} (${switches(g)})${done ? '' : ` · the ${fmtWhen(last, tz)} digest isn't posted yet`}`);
  }
  console.log(`Schedule:  ${describeSchedule(cfg.schedule)} (${tz}), reading the last ${readDays(cfg.schedule)} days · next ${fmtWhen(next, tz)}`);
  console.log(`Write-up:  ${cfg.mode}${cfg.mode === 'summary-file' ? ` (${cfg.summary.path || 'no summary.path set!'})` : ''}`);
  console.log(`Members:   ${members.filter((m) => m.active).length} opted in${members.some((m) => !m.active) ? `, ${members.filter((m) => !m.active).length} stopped` : ''}`);
  console.log(`Service:   ${serviceStatus()}`);
  const groupOf = (key) => cfg.groups.find((g) => key.includes(g.jid))?.name || '';
  console.log(`Last post: ${lastPost ? `${groupOf(lastPost[0]) ? `${groupOf(lastPost[0])}, ` : ''}${fmtWhen(new Date(lastPost[1].at), tz)}${lastPost[1].dms ? ` · ${lastPost[1].dms.sent} DMs` : ''}` : 'none yet'}`);
  const failed = Object.entries(state.attempts).filter(([k, a]) => a.lastError && !state.posted[k]);
  for (const [k, a] of failed) console.log(`Problem:   ${groupOf(k) || k}: ${a.lastError} (attempt ${a.count}/3)`);
  console.log(`Logs:      ${paths().log}`);
}

async function cmdDoctor(cfg) {
  const wacli = new Wacli(cfg);
  const ok = (b, msg, fix) => console.log(`${b ? '✅' : '❌'} ${msg}${!b && fix ? `\n     → ${fix}` : ''}`);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 20, `Node ${process.versions.node}`, 'Install Node 20 or newer (brew install node)');
  let ver = '';
  try { ver = await wacli.version(); } catch { /* */ }
  ok(!!ver, `wacli ${ver || 'not found'} (${wacli.bin})`, 'Run scripts/install.sh, or brew install openclaw/tap/wacli');
  if (ver) {
    const st = await wacli.authStatus().catch(() => ({ authenticated: false }));
    ok(st.authenticated, st.authenticated ? `WhatsApp linked as +${st.phone}` : 'WhatsApp not linked', 'wadigest link --phone +44…');
  }
  ok(cfg.groups.length > 0, cfg.groups.length ? `Groups: ${cfg.groups.map((g) => g.name).join(', ')}` : 'No group chosen', 'wadigest setup');
  const svc = serviceStatus();
  ok(svc === 'running', `Background service: ${svc}`, 'wadigest service install');
  const vt = await detectVideoTools(cfg);
  console.log(`${vt.ready ? '✅' : 'ℹ️ '} Video transcription: ${vt.ready ? vt.whisper.kind : `off (optional: ffmpeg ${vt.ffmpeg ? '✓' : '✗'}, whisper ${vt.whisper ? '✓' : '✗'})`}`);
}

async function cmdMembers(cfg, pos, flags) {
  const list = loadMembers();
  const sub = pos[0] || 'list';
  if (sub === 'list') {
    if (!list.length) return console.log('No members yet. People opt in with "!digest join agents, n8n" in the group.');
    for (const m of list) console.log(`${m.active ? '✓' : '✗'} ${m.name || '(no name)'}  ${m.jid}\n    interests: ${m.interests.join(', ') || '-'}`);
    return;
  }
  const phone = normalizePhone(flags.phone);
  if (!phone) throw new Error('--phone is required, e.g. --phone 447700900123');
  const jid = `${phone}@s.whatsapp.net`;
  if (sub === 'add') {
    const m = upsertMember(list, { jid, name: flags.name !== true ? flags.name : '', interests: flags.interests ? parseInterests(flags.interests) : undefined });
    saveMembers(list);
    return console.log(`Added ${m.name || m.jid} (${m.interests.join(', ') || 'no interests'})`);
  }
  if (sub === 'remove') {
    const m = findMember(list, jid);
    if (!m) return console.log('Not a member.');
    saveMembers(list.filter((x) => x !== m));
    return console.log(`Removed ${m.name || m.jid}`);
  }
  throw new Error(`Unknown: members ${sub}`);
}

async function cmdConfig(cfg, pos) {
  if (!pos[0] || pos[0] === 'show') {
    const view = { ...cfg, secrets: loadSecrets().anthropicApiKey ? { anthropicApiKey: 'saved' } : {} };
    return console.log(JSON.stringify(view, null, 2));
  }
  if (pos[0] === 'set-key') {
    const rl = makePrompter();
    const key = (await rl.question('Anthropic API key (sk-ant-…): ')).trim();
    rl.close();
    if (!key.startsWith('sk-')) throw new Error("That doesn't look like an API key");
    saveSecrets({ ...loadSecrets(), anthropicApiKey: key });
    return console.log(`Saved to ${paths().secrets} (only readable by you).`);
  }
  if (pos[0] === 'set') {
    const [, key, ...rest] = pos;
    const value = rest.join(' ');
    if (!key || !value) throw new Error('Usage: wadigest config set KEY VALUE');
    if (key === 'group') {
      const g = await resolveGroup(new Wacli(cfg), value);
      setGroups(cfg, [g]);
      return console.log(`Digest group: ${g.name} (${g.jid}). Any other groups were removed.`);
    }
    if (['schedule.day', 'schedule.time', 'schedule.timezone', 'schedule.everyDays', 'schedule.readDays'].includes(key)) {
      applySchedule(cfg, { [key.split('.')[1]]: value });
      saveConfig(cfg);
      return console.log(`Schedule: ${describeSchedule(cfg.schedule)} (${cfg.schedule.timezone}), reading the last ${readDays(cfg.schedule)} days`);
    }
    setConfigValue(cfg, key, value);
    saveConfig(cfg);
    return console.log(`${key} = ${JSON.stringify(key.split('.').reduce((o, k) => o[k], cfg))}`);
  }
  if (pos[0] === 'add-group' || pos[0] === 'remove-group') {
    const name = pos.slice(1).join(' ');
    if (!name) throw new Error(`Usage: wadigest config ${pos[0]} "Group name"`);
    const g = await resolveGroup(new Wacli(cfg), name);
    setGroups(cfg, pos[0] === 'add-group' ? [...cfg.groups, g] : cfg.groups.filter((x) => x.jid !== g.jid));
    return console.log(`Digest groups: ${cfg.groups.map((x) => x.name).join(', ') || 'none'}`);
  }
  if (pos[0] === 'group') {
    const [, name, step, onoff] = pos;
    const g = name && findGroups(cfg.groups, name)[0];
    if (!g || !['post', 'pin', 'dm'].includes(step) || !/^(on|off)$/.test(onoff || '')) throw new Error('Usage: wadigest config group "Group name" post|pin|dm on|off');
    g[step] = onoff === 'on';
    saveConfig(cfg);
    return console.log(`${g.name}: ${switches(g)}`);
  }
  throw new Error(`Unknown: config ${pos[0]}`);
}

async function cmdService(cfg, pos) {
  const sub = pos[0] || 'status';
  if (sub === 'install') return console.log(`Started: ${installService(cfg)}`);
  if (sub === 'uninstall') { uninstallService(); return console.log('Background service removed.'); }
  if (sub === 'status') return console.log(serviceStatus());
  throw new Error(`Unknown: service ${sub}`);
}

export async function main(argv) {
  const { pos, flags } = parseArgs(argv);
  const cmd = pos.shift() || 'setup'; // plain `wadigest` opens setup / the control panel
  if (cmd === 'help' || flags.help || cmd === '--help') return console.log(HELP);
  if (cmd === 'version' || flags.version) return console.log(VERSION);
  if (cmd === 'setup') {
    const useUI = flags.ui || (!flags.terminal && hasUI());
    return useUI ? runSetupUI({ open: !flags['no-open'], port: flags.port ? Number(flags.port) : 0 }) : cmdSetup(flags);
  }
  const cfg = ensureConfig();
  switch (cmd) {
    case 'link': return cmdLink(cfg, flags);
    case 'groups': return cmdGroups(cfg, pos.join(' '));
    case 'preview': return cmdPreview(cfg, flags);
    case 'run': return cmdRun(cfg, flags);
    case 'export': return cmdExport(cfg, flags);
    case 'status': return cmdStatus(cfg);
    case 'doctor': return cmdDoctor(cfg);
    case 'members': return cmdMembers(cfg, pos, flags);
    case 'config': return cmdConfig(cfg, pos);
    case 'service': return cmdService(cfg, pos);
    case 'daemon': return runDaemon({ once: !!flags.once });
    default:
      console.error(`Unknown command "${cmd}".\n`);
      console.log(HELP);
      process.exitCode = 2;
  }
}

export { DAYS };
