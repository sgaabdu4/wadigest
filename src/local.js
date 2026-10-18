// Local AI write-up (mode "local") through Ollama (https://ollama.com), running on this computer.
// Nothing leaves the machine. Falls back to the simple digest if Ollama isn't answering.

import { summariseAll } from './fullsummary.js';

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

// A small local model reads about 8k tokens at once, so parts stay around 14k characters.
export async function summariseWithLocal({ lines, group, days }, cfg, { fetchImpl = fetch, timeoutMs = 10 * 60_000, onProgress } = {}) {
  const url = cfg.local?.url || OLLAMA_URL;
  const model = cfg.local?.model || DEFAULT_LOCAL_MODEL;
  const ask = async (prompt, { json }) => {
    const r = await fetchImpl(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, ...(json ? { format: 'json' } : {}), options: { temperature: 0.3, num_ctx: 8192 } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return (await r.json()).response || '';
  };
  const out = await summariseAll({ lines, group, days, ask, maxChars: cfg.local?.maxChars || 14_000, onProgress });
  out.source = `local (${model})`;
  return out;
}
