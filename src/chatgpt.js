// Optional ChatGPT write-up (mode "chatgpt"). Runs `codex exec` with the user's own ChatGPT login,
// read-only in an empty folder. Any failure -> caller falls back to the no-AI digest.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summariseAll } from './fullsummary.js';
import { spawnCli } from './util.js';

// Summarising is light work, so the fast, affordable model is the default.
export const DEFAULT_CHATGPT_MODEL = 'gpt-6-luna';

function viaCodex(prompt, cfg, timeoutMs, model) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wadigest-codex-'));
    const answer = path.join(dir, 'answer.txt');
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', dir,
      ...(model ? ['-m', model] : []), '-c', 'model_reasoning_effort=low', '-o', answer, '-'];
    const child = spawnCli(cfg.chatgpt?.command || 'codex', args, { cwd: dir, stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    const done = () => fs.rmSync(dir, { recursive: true, force: true });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
    child.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    child.on('error', (e) => { clearTimeout(timer); done(); reject(new Error(e.code === 'ENOENT' ? 'Codex (`codex`) is not installed' : e.message)); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      let text = '';
      try { text = fs.readFileSync(answer, 'utf8'); } catch { /* no answer */ }
      done();
      if (code === 0 && text.trim()) return resolve(text);
      const why = err.split('\n').filter((l) => /^ERROR: /.test(l)).pop() || err.trim().split('\n').slice(-3).join(' ');
      if (/requires a newer version of Codex/i.test(why)) return reject(new Error('Codex is out of date. Update it with `npm install -g @openai/codex@latest`, then try again.'));
      reject(new Error(signal ? 'codex exec timed out' : `codex exec exited ${code}: ${why.slice(0, 400)}`));
    });
    child.stdin.end(prompt);
  });
}

/** Returns a summary object (contract shape) written by ChatGPT through Codex. Throws on any failure. */
export async function summariseWithChatGPT({ lines, group, days }, cfg, { timeoutMs = 300_000, onProgress } = {}) {
  let model = cfg.chatgpt?.model || DEFAULT_CHATGPT_MODEL;
  // Older Codex versions can't use the newest models; then Codex's own default model writes it.
  const ask = (prompt) => viaCodex(prompt, cfg, timeoutMs, model).catch((err) => {
    if (!model || !/model is not supported|unknown model|model .* not found/i.test(err.message)) throw err;
    model = '';
    return viaCodex(prompt, cfg, timeoutMs, model);
  });
  const json = await summariseAll({ lines, group, days, ask, maxChars: cfg.chatgpt?.maxChars || 150_000, onProgress });
  json.source = `chatgpt (${model || 'Codex default model'})`;
  return json;
}
