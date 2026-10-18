// Build the week's digest and deliver it: group post -> pin -> personal DMs.

import { exec } from 'node:child_process';
import fs from 'node:fs';
import { paths, saveState, writeJsonAtomic, groupConfig } from './config.js';
import { rollingWindow, readDays } from './schedule.js';
import { rankMessages } from './rank.js';
import { fetchLinkInfo } from './links.js';
import { buildDigest, mergeSummary, readSummaryFile } from './summary.js';
import { renderGroupPost, renderPersonal } from './format.js';
import { loadMembers } from './members.js';
import { processVideos } from './video.js';
import { summariseWithClaude } from './claude.js';
import { summariseWithLocal } from './local.js';
import { buildTranscript, linkInfoFrom } from './fullsummary.js';
import { log } from './log.js';
import { sleep, randomBetween, jidUser } from './util.js';

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      out[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * @returns {Promise<{digest: object, messages: number, notes: string[]}>}
 */
export async function prepareDigest({ cfg, state, wacli, window, summaryFile, fetchImpl, videos = true, onProgress = () => {} }) {
  if (!cfg.group?.jid) throw new Error('No group chosen yet. Run `wadigest setup` or `wadigest config set group "<name>"`.');
  const notes = [];
  const messages = await wacli.listMessages({ chat: cfg.group.jid, after: window.start, before: window.end });

  if (videos) {
    const v = await processVideos(wacli, cfg, state, messages, { max: 5 });
    if (v.skipped && messages.some((m) => String(m.MediaType).toLowerCase() === 'video')) notes.push(`Videos not transcribed (${v.skipped}).`);
  }

  const ranked = rankMessages(messages);
  for (const it of ranked.items) {
    const v = state.videos?.[it.msgId];
    if (it.kind === 'video' && v?.transcript) it.transcript = v.transcript;
  }

  const topN = cfg.topN || 0;
  const ai = cfg.mode === 'local' || cfg.mode === 'claude';
  if (cfg.linkTitles !== false) {
    const needInfo = ranked.items.slice(0, ai ? 40 : (topN || 40)).filter((it) => it.url && !it.title);
    await mapLimit(needInfo, 4, async (it) => {
      const info = await fetchLinkInfo(it.url, { fetchImpl, wantText: ai, timeoutMs: 8000 });
      if (info.title) it.title = info.title;
      if (info.description) it.description = info.description;
      if (info.siteName) it.siteName = info.siteName;
      if (info.excerpt) it.pageExcerpt = info.excerpt;
    });
  }

  let digest = buildDigest(ranked, { group: cfg.group, window, topN });
  digest.writtenBy = 'wadigest (no AI)';
  const transcripts = Object.fromEntries(Object.entries(state.videos || {}).filter(([, v]) => v.transcript).map(([id, v]) => [id, v.transcript]));
  const lines = buildTranscript(messages, { timeZone: cfg.schedule.timezone, linkInfo: linkInfoFrom(ranked.items), transcripts });
  const days = Math.max(1, Math.round((new Date(window.end).getTime() - new Date(window.start).getTime()) / 864e5));

  const external = summaryFile || (cfg.mode === 'summary-file' && cfg.summary?.path ? cfg.summary.path : null);
  if (external) {
    try {
      const st = fs.statSync(external);
      if (!summaryFile && Date.now() - st.mtimeMs > 6 * 864e5) throw new Error(`${external} is older than 6 days`);
      digest = mergeSummary(readSummaryFile(external), digest);
      digest.writtenBy = `summary file (${digest.source})`;
    } catch (err) {
      if (summaryFile) throw err; // explicit --summary: don't silently fall back
      notes.push(`Summary file not used, fell back to the no-AI digest: ${err.message}`);
      log.warn(notes[notes.length - 1]);
    }
  } else if (ai && lines.length) {
    const who = cfg.mode === 'claude' ? 'Claude' : 'Local AI';
    onProgress(`${who} is reading ${lines.length} messages and writing the summary`);
    try {
      const input = { lines, group: cfg.group.name || 'the group', days };
      const written = cfg.mode === 'claude' ? await summariseWithClaude(input, cfg, { onProgress }) : await summariseWithLocal(input, cfg, { fetchImpl: fetchImpl || fetch, onProgress });
      digest = mergeSummary(written, digest);
      digest.writtenBy = digest.source;
    } catch (err) {
      notes.push(`${who} write-up failed, used the simple summary instead: ${err.message}`);
      log.warn(notes[notes.length - 1]);
    }
  }

  writeJsonAtomic(paths().lastDigest, digest);
  return { digest, messages: messages.length, notes, transcript: lines };
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function runPinCommand(template, vars) {
  const cmd = template.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? shellQuote(vars[k]) : _));
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 120_000 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout)));
  });
}

/**
 * Who gets this group's DM: only people in this group. "everyone": every participant in the
 * group's member list (from wacli), with their saved interests, minus anyone who opted out.
 * "opted-in": only participants who sent !digest join. If WhatsApp's member list can't be read,
 * only members already known to be in this group are used.
 */
export async function dmRecipients(cfg, wacli) {
  const members = loadMembers();
  const audience = cfg.dms?.audience || 'everyone';
  if (audience === 'off') return [];
  let participants = [];
  try { participants = await wacli.participants(cfg.group.jid); } catch (err) { log.warn(`Couldn't read the group's member list: ${err.message}`); }
  const users = new Set(participants.map((p) => jidUser(p.jid)).filter(Boolean));
  const inThisGroup = (m) => (users.size
    ? users.has(jidUser(m.jid)) || (m.altJids || []).some((a) => users.has(jidUser(a)))
    : (m.groups || []).includes(cfg.group.jid));
  if (audience === 'opted-in' || !users.size) return members.filter((m) => m.active && inThisGroup(m));
  const out = [];
  const seen = new Set();
  for (const p of participants) {
    const u = jidUser(p.jid);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    const m = members.find((x) => jidUser(x.jid) === u || (x.altJids || []).some((a) => jidUser(a) === u));
    if (m && m.active === false) continue; // opted out
    out.push(m ? { ...m, jid: m.jid || p.jid } : { jid: p.jid, name: '', interests: [], active: true });
  }
  return out;
}

/**
 * Send it. Records the group post in state under `key` as soon as it's accepted, so a crash
 * during DMs never causes a second group post.
 */
export async function deliver({ cfg, state, wacli, digest, key, noGroup = false, noDms = false, onDm, pauseSync = (fn) => fn() }) {
  const timeZone = cfg.schedule.timezone;
  const result = { group: null, pinned: false, dms: [], skipped: [] };

  if (!noGroup) {
    const text = renderGroupPost(digest, { timeZone, audience: cfg.dms?.enabled === false ? 'off' : cfg.dms?.audience });
    const sent = await wacli.sendText(cfg.group.jid, text);
    result.group = sent;
    log.info(`Posted digest to ${cfg.group.name || cfg.group.jid} (id ${sent.id || '?'})`);
    if (key) {
      state.posted[key] = { at: new Date().toISOString(), groupMessageId: sent.id, items: digest.items.map((i) => i.id), writtenBy: digest.writtenBy };
      saveState(state);
    }
    if (sent.id && cfg.pin?.enabled !== 'off') {
      try {
        if (cfg.pin?.command) {
          await pauseSync(() => runPinCommand(cfg.pin.command, { wacli: wacli.bin, store: wacli.store, chat: cfg.group.jid, id: sent.id }));
          result.pinned = true;
        } else if (await wacli.supportsPin()) {
          await pauseSync(() => wacli.pin(cfg.group.jid, sent.id, cfg.pin?.duration || '7d'));
          result.pinned = true;
        } else {
          result.pinNote = 'this wacli can’t pin messages (run the installer to build the wadigest wacli)';
        }
        if (result.pinned) log.info(`Pinned the digest for ${cfg.pin?.duration || '7d'}`);
      } catch (err) {
        result.pinNote = err.message;
        log.warn(`Pin failed (in groups where only admins can pin, the linked number must be an admin): ${err.message}`);
      }
      if (key && state.posted[key]) { state.posted[key].pinned = result.pinned; saveState(state); }
    }
  }

  if (!noDms && cfg.dms?.enabled !== false && cfg.dms?.audience !== 'off') {
    let me = '';
    try { me = (await wacli.authStatus()).phone; } catch { /* ignore */ }
    const members = await dmRecipients(cfg, wacli);
    const max = cfg.dms?.maxPerRun ?? 100;
    let n = 0;
    for (const m of members) {
      if (me && jidUser(m.jid) === me) { result.skipped.push({ jid: m.jid, why: 'that is the linked number (WhatsApp drops self-DMs)' }); continue; }
      if (n >= max) { result.skipped.push({ jid: m.jid, why: `over the ${max} DMs per run limit` }); continue; }
      if (n > 0) await sleep(randomBetween((cfg.dms.minDelaySec ?? 8) * 1000, (cfg.dms.maxDelaySec ?? 20) * 1000));
      n++;
      try {
        const sent = await wacli.sendText(m.jid, renderPersonal(digest, m, { timeZone }));
        result.dms.push({ jid: m.jid, name: m.name, ok: true, id: sent.id });
        onDm?.(m, true);
      } catch (err) {
        result.dms.push({ jid: m.jid, name: m.name, ok: false, error: err.message });
        log.warn(`DM to ${m.name || m.jid} failed: ${err.message}`);
        onDm?.(m, false, err);
      }
    }
    if (key && state.posted[key]) {
      state.posted[key].dms = { sent: result.dms.filter((d) => d.ok).length, failed: result.dms.filter((d) => !d.ok).length };
      saveState(state);
    }
  }
  return result;
}

/** Build and send one group's digest right now (the "Run now" button / `wadigest run`). */
export async function runGroupNow({ cfg, group, state, wacli, pauseSync, onDm, onProgress = () => {} }) {
  const gc = groupConfig(cfg, group);
  const window = rollingWindow(new Date(), readDays(cfg.schedule));
  const { digest, messages, notes } = await prepareDigest({ cfg: gc, state, wacli, window, onProgress });
  onProgress(`sending (${messages} messages read)`);
  saveState(state);
  const key = gc.post ? `manual|${group.jid}|${Date.now()}` : null;
  const res = await deliver({ cfg: gc, state, wacli, digest, key, noGroup: !gc.post, pauseSync, onDm });
  return { ...res, digest, messages, notes };
}
