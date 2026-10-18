// Local AI write-up (mode "local"): a small model that comes with wadigest, run by llama.cpp's
// llama-server on this computer. Setup downloads both once into ~/.wadigest/llm (checksums checked).
// The server only runs while a summary is being written. Nothing leaves the computer.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { paths } from './config.js';
import { summariseAll } from './fullsummary.js';
import { sleep } from './util.js';

const BUILD = 'b11719';
export const BUILD_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${BUILD}`;
export const LLAMA_BUILDS = {
  'darwin-arm64': ['llama-b11719-bin-macos-arm64.tar.gz', '076a2b0d15253078b90bd520a82dc2edc6c17657968878876ba3def3e80f54ba'],
  'darwin-x64': ['llama-b11719-bin-macos-x64.tar.gz', '739708dca398960462725dd885010e10e6b9fed79e812a29f18d260af23f9929'],
  'linux-x64': ['llama-b11719-bin-ubuntu-x64.tar.gz', '2c50edd1422cdc686a1620923a7dda9a33634509566d2821155fb3d4879510a3'],
  'linux-arm64': ['llama-b11719-bin-ubuntu-arm64.tar.gz', '290aa4432ad8e28b638285be6a75d0dd6f327d9b2d95f7048a8cf5e69704bee9'],
  'win32-x64': ['llama-b11719-bin-win-cpu-x64.zip', '1b1234d208a8b851cc27cd3d96b850d1547a4e5cfc5cd75f0a9fdd1d4c5bea20'],
  'win32-arm64': ['llama-b11719-bin-win-cpu-arm64.zip', 'bb066fea4e7b396560704f05f227aa39057a27ae17aca604f1ef3d1b6503a1a3'],
};

export const MODELS = {
  'lfm2.5-1.2b': {
    label: 'LFM2.5 1.2B',
    file: 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/resolve/main/LFM2.5-1.2B-Instruct-Q4_K_M.gguf',
    sha256: 'b1b3de114215d9507409a662a501a631095a479a419584e8a2ded6304b19b4f5',
    mb: 731,
  },
  'qwen3-1.7b': {
    label: 'Qwen3 1.7B',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
    url: 'https://huggingface.co/ggml-org/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf',
    sha256: 'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5',
    mb: 1282,
  },
};
export const DEFAULT_LOCAL_MODEL = 'lfm2.5-1.2b';

export const platformKey = () => `${process.platform}-${process.arch}`;
export const llmDir = () => path.join(paths().home, 'llm');
export const modelInfo = (cfg) => MODELS[cfg?.local?.model] || MODELS[DEFAULT_LOCAL_MODEL];
export const modelPath = (cfg) => path.join(llmDir(), modelInfo(cfg).file);

/** The llama-server program inside ~/.wadigest/llm/bin, wherever the archive put it. */
export function serverBin() {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
    for (const e of entries) if (e.isFile() && e.name === name) return path.join(dir, e.name);
    if (depth > 0) for (const e of entries) if (e.isDirectory()) { const hit = walk(path.join(dir, e.name), depth - 1); if (hit) return hit; }
    return '';
  };
  return walk(path.join(llmDir(), 'bin'), 3);
}

export function localReady(cfg) {
  return !!serverBin() && fs.existsSync(modelPath(cfg));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(cfg) {
  const bin = serverBin();
  if (!bin || !fs.existsSync(modelPath(cfg))) throw new Error('local AI is not installed (choose “with local AI” on the settings screen to install it)');
  const port = await freePort();
  const child = spawn(bin, ['-m', modelPath(cfg), '--host', '127.0.0.1', '--port', String(port), '-c', '8192', '--jinja'], { cwd: path.dirname(bin), stdio: 'ignore' });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    if (exited) throw new Error('the local model could not start');
    try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok) return { url, stop: () => child.kill() }; } catch { /* still loading */ }
    await sleep(500);
  }
  child.kill();
  throw new Error('the local model took too long to start');
}

/** One chat completion, streamed so slow computers never hit fetch's wait for the first byte. */
async function complete(url, prompt, { json, timeoutMs }) {
  const r = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      stream: true,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`local model ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  let out = '';
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const data = line.replace(/^data:\s*/, '').trim();
      if (!data || data === '[DONE]' || !line.startsWith('data:')) continue;
      out += JSON.parse(data).choices?.[0]?.delta?.content || '';
    }
  }
  return out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// A small model reads about 8k tokens at once, so parts stay around 14k characters.
export async function summariseWithLocal({ lines, group, days }, cfg, { timeoutMs = 20 * 60_000, onProgress } = {}) {
  const server = await startServer(cfg);
  try {
    const ask = (prompt, { json }) => complete(server.url, prompt, { json, timeoutMs });
    const out = await summariseAll({ lines, group, days, ask, maxChars: cfg.local?.maxChars || 14_000, onProgress });
    out.source = `local (${modelInfo(cfg).label})`;
    return out;
  } finally {
    server.stop();
  }
}
