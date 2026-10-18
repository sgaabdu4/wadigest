// Local AI write-up (mode "local") through Ollama (https://ollama.com), running on this computer.
// Nothing leaves the machine. Falls back to the simple digest if Ollama isn't answering.

import { exportForSummariser, summariserPrompt, extractJson } from './summary.js';

export const DEFAULT_LOCAL_MODEL = 'llama3.2:3b';
export const OLLAMA_URL = 'http://127.0.0.1:11434';

export async function ollamaUp(url = OLLAMA_URL, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { up: false, models: [] };
    const j = await r.json();
    return { up: true, models: (j.models || []).map((m) => m.name) };
  } catch {
    return { up: false, models: [] };
  }
}

export async function summariseWithLocal(digest, cfg, { fetchImpl = fetch, timeoutMs = 10 * 60_000 } = {}) {
  const url = cfg.local?.url || OLLAMA_URL;
  const model = cfg.local?.model || DEFAULT_LOCAL_MODEL;
  const prompt = summariserPrompt(exportForSummariser(digest), cfg.topN || 5);
  const r = await fetchImpl(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, format: 'json', options: { temperature: 0.3, num_ctx: 8192 } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const j = await r.json();
  const out = extractJson(j.response || '');
  out.source = `local (${model})`;
  return out;
}
