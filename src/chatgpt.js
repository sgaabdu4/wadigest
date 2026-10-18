// Optional ChatGPT write-up (mode "chatgpt"). Runs `codex exec` with the user's own ChatGPT login,
// read-only in an empty folder. Any failure -> caller falls back to the no-AI digest.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summariseAll } from './fullsummary.js';

// Summarising is light work, so the fast, affordable model is the default.
export const DEFAULT_CHATGPT_MODEL = 'gpt-6-luna';

function viaCodex(prompt, cfg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wadigest-codex-'));
    const answer = path.join(dir, 'answer.txt');
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', dir,
      '-m', cfg.chatgpt?.model || DEFAULT_CHATGPT_MODEL, '-c', 'model_reasoning_effort="low"', '-o', answer, '-'];
    const child = spawn(cfg.chatgpt?.command || 'codex', args, { cwd: dir, stdio: ['pipe', 'ignore', 'pipe'] });
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
      reject(new Error(signal ? 'codex exec timed out' : `codex exec exited ${code}: ${err.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}

/** Returns a summary object (contract shape) written by ChatGPT through Codex. Throws on any failure. */
export async function summariseWithChatGPT({ lines, group, days }, cfg, { timeoutMs = 300_000, onProgress } = {}) {
  const json = await summariseAll({ lines, group, days, ask: (prompt) => viaCodex(prompt, cfg, timeoutMs), maxChars: cfg.chatgpt?.maxChars || 150_000, onProgress });
  json.source = `chatgpt (${cfg.chatgpt?.model || DEFAULT_CHATGPT_MODEL})`;
  return json;
}
