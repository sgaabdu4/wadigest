import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_WACLI = path.join(here, 'fixtures', 'fake-wacli.js');
export const GROUP = '120363000000000001@g.us';

/** Fresh WADIGEST_HOME + fake wacli data dir for one test. */
export function sandbox({ messages = [], groups, participants = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wadigest-test-'));
  const home = path.join(root, 'home');
  const fake = path.join(root, 'fake');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fake, { recursive: true });
  fs.chmodSync(FAKE_WACLI, 0o755);
  process.env.WADIGEST_HOME = home;
  process.env.WADIGEST_WACLI = FAKE_WACLI;
  process.env.FAKE_WACLI_DIR = fake;
  delete process.env.FAKE_WACLI_FAIL;
  fs.writeFileSync(path.join(fake, 'messages.json'), JSON.stringify(messages));
  fs.writeFileSync(path.join(fake, 'groups.json'), JSON.stringify(groups || [{ JID: GROUP, Name: 'Developer Bros', IsParent: false }, { JID: '120363000000000002@g.us', Name: 'Family', IsParent: false }]));
  fs.writeFileSync(path.join(fake, 'participants.json'), JSON.stringify(participants));
  return {
    home,
    fake,
    sent: () => {
      try { return fs.readFileSync(path.join(fake, 'sent.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
    },
    setMessages: (m) => fs.writeFileSync(path.join(fake, 'messages.json'), JSON.stringify(m)),
  };
}

let seq = 0;
/** A wacli Message row (Go field names as in wacli's JSON). */
export function msg(over = {}) {
  seq++;
  return {
    ChatJID: GROUP, ChatName: 'Developer Bros', MsgID: `M${seq}`, SenderJID: `4477000000${String(seq % 50).padStart(2, '0')}@s.whatsapp.net`,
    SenderName: `Person ${seq % 50}`, Timestamp: new Date(Date.now() - 2 * 864e5).toISOString(), FromMe: false,
    Text: '', DisplayText: '', IsForwarded: false, ForwardingScore: 0, ReactionToID: '', ReactionEmoji: '',
    MediaType: '', MediaCaption: '', Filename: '', MimeType: '', DirectPath: '', LocalPath: '', DownloadedAt: '0001-01-01T00:00:00Z',
    Starred: false, StarredAt: '0001-01-01T00:00:00Z', Edited: false, Revoked: false, DeletedForMe: false, DeliveredTo: 0, ReadBy: 0, Snippet: '',
    ...over,
  };
}

export function reaction(target, sender, emoji = '👍', over = {}) {
  return msg({ ReactionToID: target, ReactionEmoji: emoji, SenderJID: sender, Text: '', DisplayText: `Reacted ${emoji} to message`, ...over });
}

export const noFetch = async () => ({ ok: false, headers: new Map(), json: async () => ({}) });
