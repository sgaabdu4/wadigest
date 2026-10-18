// Config, state and secrets, all stored as JSON under ~/.wadigest (or $WADIGEST_HOME).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function homeDir() {
  return process.env.WADIGEST_HOME || path.join(os.homedir(), '.wadigest');
}

export function paths() {
  const home = homeDir();
  return {
    home,
    config: path.join(home, 'config.json'),
    state: path.join(home, 'state.json'),
    members: path.join(home, 'members.json'),
    secrets: path.join(home, 'secrets.json'),
    logs: path.join(home, 'logs'),
    log: path.join(home, 'logs', 'wadigest.log'),
    syncLog: path.join(home, 'logs', 'wacli-sync.log'),
    wacliStore: path.join(home, 'wacli-store'),
    tmp: path.join(home, 'tmp'),
    lastDigest: path.join(home, 'last-digest.json'),
  };
}

function defaultTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London';
  } catch {
    return 'Europe/London';
  }
}

export function defaultConfig() {
  return {
    // Each group gets its own digest. post/pin/dm switch each step on or off for that group.
    groups: [], // [{ jid, name, post, pin, dm, addedAt }]
    // everyDays: how often. day: weekday of the runs (weekly) or of the first run (other
    // intervals, fixed as start). readDays: how many days each digest covers (0 = everyDays).
    schedule: { day: 'sunday', time: '09:00', timezone: defaultTimezone(), everyDays: 7, readDays: 0, start: '' },
    topN: 0, // simple summary: 0 = everything shared (up to 40); AI summaries always cover the whole chat
    // digest = simple summary, no AI. local = a small model bundled with wadigest (llama.cpp). claude = Claude (claude -p
    // or API key). summary-file = use a summary another tool drops at summary.path.
    mode: 'digest',
    local: { model: 'qwen3-1.7b' }, // qwen3-1.7b (1.3 GB, default) or lfm2.5-1.2b (731 MB, faster, vaguer)
    summary: { path: '', waitMinutes: 60 },
    claude: { command: 'claude', model: '' },
    // audience: everyone = every group member gets the digest by DM (minus anyone who sent !digest stop),
    // opted-in = only people who sent !digest join, off = group post only.
    // deleteForMe: remove each sent DM from the runner's own chats ("delete for me"), so they don't clog the feed.
    dms: { enabled: true, audience: 'everyone', minDelaySec: 8, maxDelaySec: 20, maxPerRun: 100, deleteForMe: true },
    setupDone: false,
    // Pinning needs the wadigest build of wacli (wacli-fork/), which adds `messages pin`.
    // auto = pin when that's installed. command = custom pin command template (advanced).
    pin: { enabled: 'auto', duration: '7d', command: '' },
    video: { enabled: 'auto', whisperModel: '' }, // auto = on when ffmpeg + whisper are installed
    linkTitles: true,
    wacli: { bin: '', store: '' }, // blank = auto (bundled bin / PATH, ~/.wadigest/wacli-store)
    installedAt: new Date().toISOString(),
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`Could not read ${file}: ${err.message}`);
  }
}

export function writeJsonAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function configExists() {
  return fs.existsSync(paths().config);
}

export function loadConfig() {
  const saved = readJson(paths().config, null) || {};
  if (saved.group?.jid && !saved.groups?.length) {
    saved.groups = [newGroup(saved.group, { dm: saved.dms?.enabled !== false, addedAt: saved.installedAt })];
  }
  delete saved.group;
  return deepMerge(defaultConfig(), saved);
}

export function newGroup(g, over = {}) {
  return { jid: g.jid, name: g.name || '', post: true, pin: true, dm: true, addedAt: new Date().toISOString(), ...over };
}

/** The config as seen by one group's run: its own post/pin/DM switches and start date. */
export function groupConfig(cfg, g) {
  const dmOn = cfg.dms?.enabled !== false && g.dm !== false;
  return {
    ...cfg,
    group: g,
    post: g.post !== false,
    installedAt: g.addedAt || cfg.installedAt,
    dms: { ...cfg.dms, enabled: dmOn, audience: dmOn ? (cfg.dms?.audience || 'everyone') : 'off' },
    pin: { ...cfg.pin, enabled: g.pin === false ? 'off' : cfg.pin?.enabled },
  };
}

export function saveConfig(cfg) {
  writeJsonAtomic(paths().config, cfg);
}

/** Make sure a config file exists so installedAt is fixed at first run. */
export function ensureConfig() {
  if (!configExists()) saveConfig(defaultConfig());
  return loadConfig();
}

export function defaultState() {
  return {
    posted: {}, // weekKey -> { at, groupMessageId, items, dms }
    attempts: {}, // weekKey -> { count, lastAt, lastError }
    commandsCheckedAt: null, // ISO time; !digest commands newer than this are processed
    handledCommandIds: [],
    videos: {}, // msgId -> { at, transcript?, error? }
  };
}

export function loadState() {
  return { ...defaultState(), ...readJson(paths().state, {}) };
}

export function saveState(state) {
  state.handledCommandIds = (state.handledCommandIds || []).slice(-1000);
  // Keep video notes for ~5 weeks only.
  const cutoff = Date.now() - 35 * 864e5;
  for (const [id, v] of Object.entries(state.videos || {})) {
    if (Date.parse(v.at) < cutoff) delete state.videos[id];
  }
  writeJsonAtomic(paths().state, state);
}

export function loadSecrets() {
  return readJson(paths().secrets, {});
}

export function saveSecrets(secrets) {
  writeJsonAtomic(paths().secrets, secrets, 0o600);
  try { fs.chmodSync(paths().secrets, 0o600); } catch { /* best effort */ }
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** Set a dotted key with light validation and type coercion. Returns the new config. */
export function setConfigValue(cfg, key, rawValue) {
  const parts = key.split('.');
  let target = cfg;
  for (const p of parts.slice(0, -1)) {
    if (target[p] === undefined || target[p] === null || typeof target[p] !== 'object') {
      throw new Error(`Unknown config key "${key}"`);
    }
    target = target[p];
  }
  const leaf = parts[parts.length - 1];
  if (!(leaf in target)) throw new Error(`Unknown config key "${key}"`);
  const current = target[leaf];
  let value = rawValue;
  if (typeof current === 'number') {
    value = Number(rawValue);
    if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
  } else if (typeof current === 'boolean') {
    if (!/^(true|false|yes|no|on|off|1|0)$/i.test(rawValue)) throw new Error(`${key} must be true or false`);
    value = /^(true|yes|on|1)$/i.test(rawValue);
  }
  if (key === 'schedule.day') {
    value = String(value).toLowerCase();
    const idx = DAYS.findIndex((d) => d.startsWith(value.slice(0, 3)));
    if (idx < 0) throw new Error('schedule.day must be a weekday name, e.g. sunday');
    value = DAYS[idx];
  }
  if (key === 'schedule.everyDays' && !(Number.isInteger(value) && value >= 1 && value <= 31)) throw new Error('schedule.everyDays must be a whole number from 1 to 31');
  if (key === 'schedule.readDays' && !(Number.isInteger(value) && value >= 0 && value <= 31)) throw new Error('schedule.readDays must be 0 (same as everyDays) to 31');
  if (key === 'schedule.start' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('schedule.start must look like 2026-10-25');
  if (key === 'schedule.time' && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error('schedule.time must look like 09:00');
  }
  if (key === 'schedule.timezone') {
    try { new Intl.DateTimeFormat('en-GB', { timeZone: value }); } catch { throw new Error(`Unknown timezone "${value}"`); }
  }
  if (key === 'mode' && !['digest', 'local', 'claude', 'summary-file'].includes(value)) {
    throw new Error('mode must be digest, local, claude or summary-file');
  }
  if (key === 'dms.audience' && !['everyone', 'opted-in', 'off'].includes(value)) throw new Error('dms.audience must be everyone, opted-in or off');
  if (key === 'topN' && (value < 0 || value > 40)) throw new Error('topN must be 0 (everything) to 40');
  if (key === 'video.enabled' && !['auto', 'on', 'off'].includes(String(value))) {
    throw new Error('video.enabled must be auto, on or off');
  }
  target[leaf] = value;
  return cfg;
}

export { DAYS };
