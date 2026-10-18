#!/usr/bin/env node
// Stand-in for wacli used by the tests. Output shapes copied from wacli 0.22's source
// (internal/out envelope, store.Message Go field names, MessagePage paging).
// Data comes from $FAKE_WACLI_DIR/{messages,groups,participants}.json; sends are appended to sent.jsonl.

import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_WACLI_DIR;
const argv = process.argv.slice(2);
const out = (data) => console.log(JSON.stringify({ success: true, data, error: null }));
const fail = (msg) => { console.log(JSON.stringify({ success: false, data: null, error: msg })); process.exit(1); };
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };

if (argv[0] === '--version') { console.log('wacli 0.22.0 (fake)'); process.exit(0); }

// strip global flags
const rest = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--store') { i++; continue; }
  if (['--json', '--read-only', '--asc', '--no-preview', '--events', '--follow', '--once', '--help', '--unpin', '--refresh-groups'].includes(a)) { flags[a.slice(2)] = true; continue; }
  if (a.startsWith('--')) { flags[a.slice(2)] = argv[++i]; continue; }
  rest.push(a);
}
const cmd = rest.join(' ');

if (process.env.FAKE_WACLI_FAIL && cmd.startsWith(process.env.FAKE_WACLI_FAIL)) fail(`simulated failure for ${cmd}`);

if (rest[0] === 'auth' && rest.length === 1) {
  // pairing: emit a code (or QR), "connect" after FAKE_LINK_MS, mark the store linked, exit
  const ev = (event, data) => console.error(JSON.stringify({ event, data, ts: Date.now() }));
  if (flags.phone) ev('pair_code', { phone: flags.phone, code: 'K7QX-2M9P' }); else ev('qr_code', { code: '2@fakeQRpayload,abc,def,ghi' });
  setTimeout(() => { ev('connected', {}); ev('progress', { messages: 1234 }); }, Number(process.env.FAKE_LINK_MS || 3000));
  setTimeout(() => { fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ authenticated: true, linked_jid: `${String(flags.phone || '447000000001').replace(/\D/g, '')}:3@s.whatsapp.net`, phone: String(flags.phone || '447000000001').replace(/\D/g, '') })); process.exit(0); }, Number(process.env.FAKE_LINK_MS || 3000) + 1500);
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => {}, 1e6);
}
else if (cmd === 'messages pin' && argv.includes('--help')) { console.log('Pin (or unpin) a message for everyone in a chat'); process.exit(0); }
else if (cmd === 'auth logout') { fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ authenticated: false })); out({ logged_out: true }); }
else if (rest[0] === 'sync' && !flags.once) { console.error('{"event":"connected"}'); setInterval(() => {}, 1e6); process.on('SIGINT', () => process.exit(0)); }
else switch (cmd) {
  case 'auth status':
    out(read('auth.json', { authenticated: true, linked_jid: '447000000001:12@s.whatsapp.net', phone: '447000000001' }));
    break;
  case 'groups list': {
    let gs = read('groups.json', []);
    if (flags.query) gs = gs.filter((g) => g.Name.toLowerCase().includes(flags.query.toLowerCase()));
    out(gs);
    break;
  }
  case 'groups participants list':
    out(read('participants.json', []).filter((p) => !flags.jid || !p.group_jid || p.group_jid === flags.jid));
    break;
  case 'messages list': {
    let ms = read('messages.json', []);
    if (flags.chat) ms = ms.filter((m) => m.ChatJID === flags.chat);
    if (flags.after) ms = ms.filter((m) => Date.parse(m.Timestamp) > Date.parse(flags.after));
    if (flags.before) ms = ms.filter((m) => Date.parse(m.Timestamp) < Date.parse(flags.before));
    ms.sort((a, b) => Date.parse(a.Timestamp) - Date.parse(b.Timestamp));
    if (!flags.asc) ms.reverse();
    const limit = Number(flags.limit || 50);
    const offset = flags.cursor ? Number(Buffer.from(flags.cursor, 'base64').toString()) : 0;
    const page = ms.slice(offset, offset + limit);
    const hasMore = ms.length > offset + limit;
    out({ messages: page, fts: false, page: { has_more: hasMore, next_cursor: hasMore ? Buffer.from(String(offset + limit)).toString('base64') : null }, source: { last_sync_at: new Date().toISOString(), scope: 'local_archive' } });
    break;
  }
  case 'send text': {
    const id = `SENT${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    fs.appendFileSync(path.join(dir, 'sent.jsonl'), JSON.stringify({ to: flags.to, message: flags.message, id }) + '\n');
    out({ sent: true, to: flags.to, id });
    break;
  }
  case 'messages pin':
    fs.appendFileSync(path.join(dir, 'sent.jsonl'), JSON.stringify({ pin: flags.id, chat: flags.chat, duration: flags.duration }) + '\n');
    out({ pinned: true, chat: flags.chat, id: flags.id, pin_id: 'PIN1', duration_secs: 604800 });
    break;
  case 'sync':
    out({});
    break;
  case 'media download':
    fs.writeFileSync(flags.output, 'fake video');
    out({ path: flags.output, bytes: 10, source: 'server' });
    break;
  default:
    fail(`fake wacli: unsupported command "${cmd}"`);
}
