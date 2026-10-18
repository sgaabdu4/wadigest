import { spawn } from 'node:child_process';
// Small shared helpers. No dependencies.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

/** Digits only, no leading +. "+44 7700 900123" -> "447700900123" */
export function normalizePhone(input) {
  return String(input || '').replace(/[^\d]/g, '');
}

/** "447700900123@s.whatsapp.net" -> "447700900123"; "123@lid" -> "123" */
export function jidUser(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

export function isGroupJid(jid) {
  return String(jid || '').endsWith('@g.us');
}

export function isPersonJid(jid) {
  const s = String(jid || '');
  return s.endsWith('@s.whatsapp.net') || s.endsWith('@lid');
}

export function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:–-]+$/, '') + '…';
}

export function wordCount(text) {
  const s = String(text || '').trim();
  return s ? s.split(/\s+/).length : 0;
}

/** Parse a comma/space separated interest list into clean lowercase tags. */
export function parseInterests(text) {
  return [...new Set(
    String(text || '')
      .split(/[,;\n]+/)
      .map((s) => s.trim().toLowerCase().replace(/^[#\s]+/, '').replace(/\s+/g, ' '))
      .filter((s) => s.length >= 2 && s.length <= 40),
  )].slice(0, 15);
}

export function plural(n, word, pluralWord) {
  return `${n} ${n === 1 ? word : (pluralWord || word + 's')}`;
}

/** Start a command. On Windows, npm's launchers (claude.cmd, codex.cmd) only start through cmd.exe. */
export function spawnCli(cmd, args, opts = {}) {
  if (process.platform !== 'win32') return spawn(cmd, args, opts);
  const q = (a) => (/[\s"^&|<>()%!]/.test(String(a)) ? `"${String(a).replace(/"/g, '""')}"` : String(a));
  return spawn([cmd, ...args].map(q).join(' '), { ...opts, shell: true, windowsHide: true });
}
