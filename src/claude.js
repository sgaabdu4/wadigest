// Optional Claude write-up (mode "claude"). Off by default.
// Uses the Anthropic API when an API key is saved (`wadigest config set-key`), otherwise
// Claude Code's `claude -p` with the user's own login. Any failure -> caller falls back
// to the no-AI digest, so a post still goes out.

import { spawn } from 'node:child_process';
import { loadSecrets } from './config.js';
import { exportForSummariser, summariserPrompt, extractJson } from './summary.js';

const DEFAULT_API_MODEL = 'claude-sonnet-5-5';

function viaCli(prompt, cfg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'text'];
    if (cfg.claude?.model) args.push('--model', cfg.claude.model);
    const child = spawn(cfg.claude?.command || 'claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('claude -p timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'Claude Code (`claude`) is not installed' : e.message)); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude -p exited ${code}: ${err.trim().slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}

async function viaApi(prompt, apiKey, cfg, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: cfg.claude?.model || DEFAULT_API_MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${j?.error?.message || 'request failed'}`);
    return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  } finally {
    clearTimeout(timer);
  }
}

/** Returns a summary object (contract shape) written by Claude. Throws on any failure. */
export async function summariseWithClaude(digest, cfg, { timeoutMs = 180_000 } = {}) {
  const prompt = summariserPrompt(exportForSummariser(digest), cfg.topN || 5);
  const apiKey = process.env.ANTHROPIC_API_KEY || loadSecrets().anthropicApiKey;
  const text = apiKey ? await viaApi(prompt, apiKey, cfg, timeoutMs) : await viaCli(prompt, cfg, timeoutMs);
  const json = extractJson(text);
  json.source = apiKey ? 'claude-api' : 'claude-code';
  return json;
}
