// Background loop: keeps `wacli sync --follow` alive, answers !digest commands,
// transcribes new videos, and posts each group's digest when its slot comes round.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig, loadState, saveState, paths, groupConfig } from './config.js';
import { Wacli } from './wacli.js';
import { parseCommand, applyCommand } from './commands.js';
import { loadMembers, saveMembers, findMember, addGroups } from './members.js';
import { decide, windowFor, readDays } from './schedule.js';
import { prepareDigest, deliver } from './pipeline.js';
import { processVideos } from './video.js';
import { log, setConsoleLogging } from './log.js';
import { isGroupJid, isPersonJid, jidUser, sleep } from './util.js';

const TICK_MS = Number(process.env.WADIGEST_TICK_MS) || 60_000;
const SYNC_WARMUP_MS = Number(process.env.WADIGEST_WARMUP_MS) || 90_000; // let sync catch up after start/wake before reading
const VIDEO_EVERY_MS = 3 * 3600e3;

/** Process new !digest commands once. Returns how many were handled. */
export async function processCommands({ cfg, state, wacli, now = new Date() }) {
  const groups = (cfg.groups || []).filter((g) => g.jid);
  if (!groups.length) return 0;
  const floor = Math.max(Date.parse(cfg.installedAt) || 0, now.getTime() - 24 * 3600e3);
  const since = Math.max(floor, state.commandsCheckedAt ? Date.parse(state.commandsCheckedAt) : now.getTime() - 15 * 60e3);
  const msgs = await wacli.listMessages({ after: new Date(since) });
  const handled = new Set(state.handledCommandIds || []);
  const members = loadMembers();
  const byGroup = new Map(); // group jid -> Set of member user ids
  const usersOf = async (g) => {
    if (!byGroup.has(g.jid)) byGroup.set(g.jid, new Set((await wacli.participants(g.jid).catch(() => [])).map((p) => jidUser(p.jid))));
    return byGroup.get(g.jid);
  };
  let count = 0;
  let membersChanged = false;

  for (const m of msgs) {
    if (m.FromMe || handled.has(m.MsgID)) continue;
    const cmd = parseCommand(m.Text);
    if (!cmd) continue;
    const group = groups.find((g) => g.jid === m.ChatJID);
    const inGroup = !!group;
    const isDm = isPersonJid(m.ChatJID);
    if (!inGroup && !isDm) continue; // some other group: not ours to answer
    handled.add(m.MsgID);
    count++;
    const senderJid = m.SenderJID || m.ChatJID;
    const replyTo = isDm ? m.ChatJID : senderJid;

    const me = [jidUser(senderJid), jidUser(m.ChatJID)];
    const memberOf = group ? [group.jid] : [];
    if (isDm) {
      for (const g of groups) {
        const users = await usersOf(g);
        if (me.some((u) => u && users.has(u))) memberOf.push(g.jid);
      }
    }
    if (isDm && cmd.verb === 'join') {
      const known = (await Promise.all(groups.map(usersOf))).some((s) => s.size);
      if (known && !memberOf.length) {
        await safeSend(wacli, replyTo, `This digest is for members of ${groups.map((g) => g.name || 'the group').join(', ')}. Send *!digest join …* inside the group to opt in.`);
        continue;
      }
    }
    const groupName = (group || (groups.length === 1 ? groups[0] : null))?.name || '';
    const res = applyCommand(cmd, { senderJid, senderName: m.SenderName || '' }, members, { groupName, schedule: cfg.schedule });
    const who = findMember(members, senderJid);
    if (who && memberOf.length) { addGroups(who, memberOf); membersChanged = true; }
    if (res.changed) membersChanged = true;
    log.info(`!digest ${cmd.verb} from ${m.SenderName || senderJid}${inGroup ? ' (group)' : ' (DM)'}`);
    await safeSend(wacli, replyTo, res.reply);
  }
  if (membersChanged) saveMembers(members);
  state.handledCommandIds = [...handled];
  state.commandsCheckedAt = new Date(now.getTime() - 120_000).toISOString(); // small overlap; ids dedupe
  return count;
}

async function safeSend(wacli, to, text) {
  try {
    await wacli.sendText(to, text);
  } catch (err) {
    log.warn(`Reply to ${to} failed: ${err.message}`);
  }
}

/** Run each group's digest that is due. Returns one result per group. */
export async function maybeRunDue({ cfg, state, wacli, now = new Date(), pauseSync }) {
  const out = [];
  for (const g of cfg.groups || []) {
    if (g.jid) out.push(await maybeRunGroup({ cfg: groupConfig(cfg, g), state, wacli, now, pauseSync }));
  }
  return out;
}

async function maybeRunGroup({ cfg, state, wacli, now, pauseSync }) {
  const d = decide(now, cfg, state);
  if (!d.due) return d;
  const prev = state.attempts[d.key] || { count: 0 };
  state.attempts[d.key] = { count: prev.count + 1, lastAt: now.toISOString() };
  saveState(state);
  log.info(`Digest for ${d.key}: ${d.reason}`);
  try {
    const window = windowFor(d.slot, cfg.schedule.timezone, readDays(cfg.schedule));
    const { digest, messages, notes } = await prepareDigest({ cfg, state, wacli, window });
    notes.forEach((n) => log.warn(n));
    const res = await deliver({ cfg, state, wacli, digest, key: d.key, pauseSync, noGroup: !cfg.post });
    log.info(`Done for ${d.key}: ${messages} messages read, ${digest.items.length} items, ${res.dms.filter((x) => x.ok).length} DMs sent`);
    delete state.attempts[d.key].lastError;
    saveState(state);
    return { ...d, ran: true };
  } catch (err) {
    state.attempts[d.key].lastError = String(err.message || err).slice(0, 500);
    saveState(state);
    log.error(`Digest for ${d.key} failed (attempt ${state.attempts[d.key].count}): ${err.message}`);
    return { ...d, ran: false, error: err.message };
  }
}

function syncLoggedOut() {
  try {
    const fd = fs.openSync(paths().syncLog, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 8192);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return /"event":"logged_out"|logged out/i.test(buf.toString());
  } catch {
    return false;
  }
}

export async function runDaemon({ once = false } = {}) {
  setConsoleLogging(false);
  if (process.stdout.isTTY) console.log(`wadigest is running. Leave this window open. Ctrl+C stops it.\nLog: ${paths().log}`);
  let cfg = loadConfig();
  const wacli = new Wacli(cfg);
  let child = null;
  let childStartedAt = 0;
  let backoff = 5_000;
  let stopping = false;
  let pausing = false;
  let loggedOut = false;
  let lastVideoRun = 0;

  const syncPidFile = paths().home + '/sync.pid';
  // A previous daemon that died hard can leave its `wacli sync` running and holding the store lock.
  try {
    const old = Number(fs.readFileSync(syncPidFile, 'utf8'));
    const cmdline = old ? execFileSync('ps', ['-p', String(old), '-o', 'command='], { encoding: 'utf8' }) : '';
    if (/wacli/.test(cmdline) && /sync/.test(cmdline)) { process.kill(old, 'SIGINT'); log.info(`Stopped leftover wacli sync (pid ${old})`); await sleep(3000); }
  } catch { /* none running */ }

  const startSync = () => {
    if (stopping || loggedOut) return;
    child = wacli.spawnFollow(paths().syncLog);
    childStartedAt = Date.now();
    try { fs.writeFileSync(syncPidFile, String(child.pid)); } catch { /* ignore */ }
    log.info(`wacli sync started (pid ${child.pid})`);
    child.on('exit', (code, signal) => {
      child = null;
      try { fs.rmSync(syncPidFile, { force: true }); } catch { /* ignore */ }
      if (stopping || pausing) return;
      if (syncLoggedOut()) {
        loggedOut = true;
        log.error('WhatsApp unlinked this device. Run `wadigest link` to link again, then restart the service.');
        return;
      }
      const ranFor = Date.now() - childStartedAt;
      backoff = ranFor > 10 * 60e3 ? 5_000 : Math.min(backoff * 2, 5 * 60e3);
      log.warn(`wacli sync exited (${signal || code}); restarting in ${Math.round(backoff / 1000)}s`);
      setTimeout(startSync, backoff);
    });
  };

  /** Stop sync, run fn (which needs wacli's store lock, e.g. pinning), start sync again. */
  const pauseSync = async (fn) => {
    pausing = true;
    try {
      if (child) {
        const c = child;
        const exited = new Promise((r) => c.once('exit', r));
        c.kill('SIGINT');
        await Promise.race([exited, sleep(20_000)]);
        if (child === c) c.kill('SIGKILL');
        await sleep(500);
      }
      return await fn();
    } finally {
      pausing = false;
      startSync();
    }
  };

  const shutdown = () => {
    stopping = true;
    log.info('Stopping');
    if (child) child.kill('SIGINT');
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  fs.writeFileSync(paths().home + '/daemon.pid', String(process.pid));
  log.info(`wadigest daemon started (pid ${process.pid})`);
  startSync();

  let lastTick = Date.now();
  while (!stopping) {
    await sleep(once ? SYNC_WARMUP_MS : TICK_MS);
    const now = Date.now();
    if (now - lastTick > 3 * TICK_MS) {
      log.info(`Woke up after ${Math.round((now - lastTick) / 60e3)} min; letting sync catch up`);
      childStartedAt = Math.max(childStartedAt, now - SYNC_WARMUP_MS / 3);
    }
    lastTick = now;
    if (!child || now - childStartedAt < SYNC_WARMUP_MS) continue;
    try {
      cfg = loadConfig();
      const state = loadState();
      await processCommands({ cfg, state, wacli });
      saveState(state);
      if (cfg.groups.length && now - lastVideoRun > VIDEO_EVERY_MS) {
        lastVideoRun = now;
        for (const g of cfg.groups) {
          const msgs = await wacli.listMessages({ chat: g.jid, after: new Date(now - readDays(cfg.schedule) * 864e5) });
          await processVideos(wacli, cfg, state, msgs, { max: 5 });
        }
        saveState(state);
      }
      await maybeRunDue({ cfg, state, wacli, pauseSync });
    } catch (err) {
      log.error(`Daemon tick failed: ${err.message}`);
    }
    if (once) break;
  }
  if (child) child.kill('SIGINT');
}
