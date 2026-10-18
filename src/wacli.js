// Thin wrapper around the wacli CLI (https://github.com/openclaw/wacli, v0.22).
//
// Contract used (from wacli's source, cmd/wacli + internal/out):
//   --json prints one line: {"success":bool,"data":...,"error":string|null}
//   messages list -> data = { messages: Message[], fts, page: {has_more, next_cursor}, source }
//   Message keys are Go field names: ChatJID, MsgID, SenderJID, SenderName, Timestamp (RFC3339),
//   FromMe, Text, DisplayText, QuotedMsgID, IsForwarded, ReactionToID, ReactionEmoji,
//   MediaType, MediaCaption, Filename, MimeType, Revoked, ...
//   Reactions are their own message rows with ReactionToID set; an empty emoji clears it.
//   groups list -> data = Group[] with JID, Name, IsParent, LinkedParentJID, ...
//   send text -> data = { sent: true, to, id }
// Read commands use --read-only so they work while `sync --follow` holds the store lock;
// sends are delegated by wacli to the running follow process.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

export class WacliError extends Error {
  constructor(message, { args, stderr, code } = {}) {
    super(message);
    this.name = 'WacliError';
    this.args = args;
    this.stderr = stderr;
    this.code = code;
  }
}

export function resolveWacliBin(cfg) {
  if (process.env.WADIGEST_WACLI) return process.env.WADIGEST_WACLI;
  if (cfg?.wacli?.bin) return cfg.wacli.bin;
  const bundled = path.join(paths().home, 'bin', process.platform === 'win32' ? 'wacli.exe' : 'wacli');
  if (fs.existsSync(bundled)) return bundled;
  return 'wacli';
}

export function resolveStore(cfg) {
  return cfg?.wacli?.store || paths().wacliStore;
}

function parseEnvelope(stdout) {
  const lines = String(stdout || '').trim().split('\n').reverse();
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object' && 'success' in obj) return obj;
    } catch { /* keep looking */ }
  }
  return null;
}

export class Wacli {
  constructor(cfg) {
    this.bin = resolveWacliBin(cfg);
    this.store = resolveStore(cfg);
  }

  baseArgs({ json = true, readOnly = false } = {}) {
    const a = ['--store', this.store];
    if (json) a.push('--json');
    if (readOnly) a.push('--read-only');
    return a;
  }

  /** Run a wacli command and return the parsed `data` from its JSON envelope. */
  run(args, { readOnly = false, timeoutMs = 120_000 } = {}) {
    const full = [...this.baseArgs({ json: true, readOnly }), ...args];
    fs.mkdirSync(this.store, { recursive: true, mode: 0o700 });
    return new Promise((resolve, reject) => {
      execFile(this.bin, full, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
        const env = parseEnvelope(stdout);
        if (env) {
          if (env.success) return resolve(env.data);
          return reject(new WacliError(env.error || 'wacli reported an error', { args, stderr }));
        }
        if (err) {
          if (err.code === 'ENOENT') {
            return reject(new WacliError(`wacli not found (looked for "${this.bin}"). Run the installer or set wacli.bin.`, { args, code: 'ENOENT' }));
          }
          const msg = String(stderr || err.message).trim().split('\n').slice(-3).join(' ');
          return reject(new WacliError(`wacli ${args.slice(0, 2).join(' ')} failed: ${msg}`, { args, stderr, code: err.code }));
        }
        reject(new WacliError(`wacli ${args.slice(0, 2).join(' ')} returned no JSON`, { args, stderr }));
      });
    });
  }

  version() {
    return new Promise((resolve, reject) => {
      execFile(this.bin, ['--version'], { timeout: 15_000 }, (err, stdout) => {
        if (err) return reject(new WacliError(err.code === 'ENOENT' ? `wacli not found (looked for "${this.bin}")` : err.message, { code: err.code }));
        resolve(String(stdout).trim().replace(/^wacli\s+/i, ''));
      });
    });
  }

  async authStatus() {
    const d = await this.run(['auth', 'status'], { readOnly: true, timeoutMs: 30_000 });
    return { authenticated: !!d?.authenticated, phone: d?.phone || '', linkedJid: d?.linked_jid || '' };
  }

  async groups(query = '') {
    const args = ['groups', 'list', '--limit', '1000'];
    if (query) args.push('--query', query);
    const d = await this.run(args, { readOnly: true });
    return (Array.isArray(d) ? d : []).map((g) => ({ jid: g.JID, name: g.Name || '', isParent: !!g.IsParent }));
  }

  /** Live refresh of joined groups; needs the store lock, so not while the daemon runs. */
  refreshGroups() {
    return this.run(['sync', '--once', '--refresh-groups', '--idle-exit', '10s'], { timeoutMs: 5 * 60_000 });
  }

  async participants(groupJid) {
    const d = await this.run(['groups', 'participants', 'list', '--jid', groupJid], { readOnly: true });
    return (Array.isArray(d) ? d : []).map((p) => ({ jid: p.user_jid || p.UserJID, role: p.role || p.Role || '' }));
  }

  /**
   * All messages in a window, oldest first. Pages with --cursor; if a concurrent sync
   * invalidates the cursor, restarts once with one large page.
   */
  async listMessages({ chat, after, before, limit = 2000 } = {}) {
    const base = ['messages', 'list', '--asc'];
    if (chat) base.push('--chat', chat);
    if (after) base.push('--after', new Date(after).toISOString());
    if (before) base.push('--before', new Date(before).toISOString());
    const fetchAll = async (pageSize) => {
      const out = [];
      let cursor = null;
      for (let i = 0; i < 200; i++) {
        const args = [...base, '--limit', String(pageSize)];
        if (cursor) args.push('--cursor', cursor);
        const d = await this.run(args, { readOnly: true });
        out.push(...(d?.messages || []));
        if (!d?.page?.has_more || !d.page.next_cursor) return out;
        cursor = d.page.next_cursor;
      }
      return out;
    };
    try {
      return await fetchAll(limit);
    } catch (err) {
      if (/cursor/i.test(err.message)) return fetchAll(50_000);
      throw err;
    }
  }

  async sendText(to, message) {
    // Right after sync restarts, the store is briefly locked before sends can be handed to it.
    for (let attempt = 0; ; attempt++) {
      try {
        const d = await this.run(['send', 'text', '--to', to, '--message', message, '--no-preview', '--post-send-wait', '2s'], { timeoutMs: 120_000 });
        return { id: d?.id || '', to: d?.to || to };
      } catch (err) {
        if (attempt >= 6 || !/lock|delegate|starting up/i.test(err.message)) throw err;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  /** True when this wacli has the wadigest fork's `messages pin` command. */
  async supportsPin() {
    if (this._pin !== undefined) return this._pin;
    this._pin = await new Promise((resolve) => {
      execFile(this.bin, ['messages', 'pin', '--help'], { timeout: 15_000 }, (err, stdout) => resolve(!err && /unpin/i.test(String(stdout))));
    });
    return this._pin;
  }

  /** Pin a message for everyone (needs the store lock: pause sync first). */
  pin(chat, msgId, duration = '7d') {
    return this.run(['messages', 'pin', '--chat', chat, '--id', msgId, '--duration', duration], { timeoutMs: 120_000 });
  }

  /** Remove a message from this account only ("delete for me"); the other person keeps it. */
  deleteForMe(chat, msgId) {
    return this.run(['messages', 'delete', '--chat', chat, '--id', msgId, '--for-me'], { timeoutMs: 120_000 });
  }

  /** Download one media file to `outFile` without touching the store (safe while sync runs). */
  async downloadMedia(chat, msgId, outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const d = await this.run(['media', 'download', '--chat', chat, '--id', msgId, '--output', outFile], { readOnly: true, timeoutMs: 10 * 60_000 });
    return d?.path || d?.Path || outFile;
  }

  /** Interactive pairing. Prints the 8-character code (or QR) in the terminal. */
  link({ phone } = {}) {
    const args = [...this.baseArgs({ json: false }), 'auth', '--idle-exit', '30s'];
    if (phone) args.push('--phone', phone);
    fs.mkdirSync(this.store, { recursive: true, mode: 0o700 });
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, { stdio: 'inherit' });
      child.on('error', (e) => reject(new WacliError(e.code === 'ENOENT' ? `wacli not found (looked for "${this.bin}")` : e.message)));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new WacliError(`wacli auth exited with code ${code}`))));
    });
  }

  /**
   * Pairing for a UI: `auth --events` reports {"event":"qr_code"|"pair_code"|"connected"|"progress",...}
   * as NDJSON on stderr. Returns the child; onEvent gets each parsed event.
   */
  linkWithEvents({ phone, onEvent, logFile }) {
    const args = [...this.baseArgs({ json: false }), '--events', 'auth', '--idle-exit', '20s'];
    if (phone) args.push('--phone', phone);
    else args.push('--qr-format', 'text');
    fs.mkdirSync(this.store, { recursive: true, mode: 0o700 });
    const child = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let log = null;
    if (logFile) {
      try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); log = fs.createWriteStream(logFile, { flags: 'a' }); log.on('error', () => {}); } catch { log = null; }
    }
    child.stderr.on('data', (d) => {
      log?.write(d);
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try { onEvent(JSON.parse(line)); } catch { /* not an event */ }
      }
    });
    child.stdout.on('data', (d) => log?.write(d));
    child.on('exit', () => log?.end());
    return child;
  }

  /** Long-running `sync --follow`; caller supervises the returned child. */
  spawnFollow(logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.mkdirSync(this.store, { recursive: true, mode: 0o700 });
    const fd = fs.openSync(logFile, 'a');
    const args = [...this.baseArgs({ json: false }), '--events', 'sync', '--follow', '--max-reconnect', '0', '--presence-mode', 'quiet', '--send-spacing', '1s-3s'];
    const child = spawn(this.bin, args, { stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    return child;
  }
}
