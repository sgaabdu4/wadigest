// Install / detect helpers shared by the setup page and the terminal wizard.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { ollamaUp, DEFAULT_LOCAL_MODEL } from './local.js';
import { detectVideoTools, defaultWhisperModel } from './video.js';
import { sleep } from './util.js';

const which = (bin) => new Promise((resolve) => {
  if (!/^[\w.-]+$/.test(bin)) return resolve('');
  if (process.platform === 'win32') return execFile('where', [bin], (err, out) => resolve(err ? '' : String(out).split(/\r?\n/)[0].trim()));
  execFile('/bin/sh', ['-c', `command -v ${bin}`], (err, out) => resolve(err ? '' : String(out).trim()));
});

/** Should setup show the browser page? (A screen is available and we're not over SSH.) */
export function hasUI() {
  if (process.env.WADIGEST_UI === '0') return false;
  if (process.env.WADIGEST_UI === '1') return true;
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  if (process.platform === 'darwin' || process.platform === 'win32') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

export async function detectClaude() {
  const bin = await which('claude');
  return { cli: !!bin, bin };
}

/** Run a command, streaming each output line to onLog. Resolves on exit 0. */
export function runStreaming(cmd, args, onLog, { env } = {}) {
  return new Promise((resolve, reject) => {
    onLog(`$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const parts = buf.split(/\r|\n/);
      buf = parts.pop();
      for (const p of parts) if (p.trim()) onLog(p.trim());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? `${cmd} is not installed` : e.message)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args[0] || ''} failed (exit ${code})`))));
  });
}

async function download(url, file, onLog) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  onLog(`Downloading ${path.basename(file)}…`);
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`Download failed (${r.status})`);
  const total = Number(r.headers.get('content-length')) || 0;
  const tmp = file + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0;
  let lastPct = -1;
  for await (const chunk of r.body) {
    out.write(chunk);
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct >= 0 && pct !== lastPct && pct % 5 === 0) { lastPct = pct; onLog(`Downloading ${path.basename(file)}: ${pct}%`); }
  }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  fs.renameSync(tmp, file);
}

async function brewOrExplain(onLog) {
  const brew = await which('brew');
  if (!brew) throw new Error(process.platform === 'darwin'
    ? 'Homebrew is needed for this. Install it from https://brew.sh (one command), then try again.'
    : 'Install it with your package manager, then try again.');
  return brew;
}

/** Ollama + the local model. */
export async function installLocalAI({ model = DEFAULT_LOCAL_MODEL, onLog = () => {} } = {}) {
  let ollama = await which('ollama');
  if (!ollama && process.platform === 'win32') {
    if (!(await which('winget'))) throw new Error('Install Ollama from https://ollama.com/download (one installer), then try again.');
    onLog('Installing Ollama (runs AI models on this computer)…');
    await runStreaming('winget', ['install', '-e', '--id', 'Ollama.Ollama', '--accept-package-agreements', '--accept-source-agreements', '--silent'], onLog);
    const guess = `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe`;
    ollama = (await which('ollama')) || (fs.existsSync(guess) ? guess : '');
    if (!ollama) throw new Error('Ollama installed. Open it once from the Start menu, then try again.');
  }
  if (!ollama) {
    if (process.platform === 'linux' && !(await which('brew'))) {
      throw new Error('Install Ollama with: curl -fsSL https://ollama.com/install.sh | sh  (it asks for your password), then try again.');
    }
    await brewOrExplain(onLog);
    onLog('Installing Ollama (runs AI models on this computer)…');
    await runStreaming('brew', ['install', 'ollama'], onLog);
    ollama = await which('ollama');
  }
  if (!(await ollamaUp()).up) {
    onLog('Starting Ollama…');
    if (await which('brew')) await runStreaming('brew', ['services', 'start', 'ollama'], onLog).catch(() => {});
    if (!(await ollamaUp()).up) {
      const child = spawn(ollama || 'ollama', ['serve'], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    for (let i = 0; i < 30 && !(await ollamaUp()).up; i++) await sleep(1000);
    if (!(await ollamaUp()).up) throw new Error("Ollama didn't start. Open the Ollama app once, then try again.");
  }
  const { models } = await ollamaUp();
  if (!models.some((m) => m === model || m.startsWith(model + ':') || m === `${model}:latest`)) {
    onLog(`Downloading the ${model} model (about 2 GB, one time)…`);
    await runStreaming(ollama || 'ollama', ['pull', model], onLog);
  }
  onLog(`✓ Local AI ready (${model})`);
}

/** ffmpeg + whisper.cpp + a multilingual model, for transcribing group videos. */
export async function installVideo({ onLog = () => {} } = {}) {
  if (process.platform === 'win32') throw new Error('Video transcripts are not available on Windows yet.');
  const tools = await detectVideoTools({});
  if (!tools.ffmpeg || !(await which('whisper-cli'))) {
    await brewOrExplain(onLog);
    const pkgs = [!tools.ffmpeg && 'ffmpeg', !(await which('whisper-cli')) && 'whisper-cpp'].filter(Boolean);
    onLog(`Installing ${pkgs.join(' and ')} (for video transcripts)…`);
    await runStreaming('brew', ['install', ...pkgs], onLog);
  }
  const model = defaultWhisperModel();
  if (!fs.existsSync(model)) await download('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin', model, onLog);
  onLog('✓ Video transcripts ready');
}

export async function localStatus(cfg) {
  const o = await ollamaUp(cfg.local?.url);
  const model = cfg.local?.model || DEFAULT_LOCAL_MODEL;
  const v = await detectVideoTools(cfg);
  return {
    ollama: o.up,
    model,
    modelReady: o.models.some((m) => m === model || m.startsWith(model + ':') || m === `${model}:latest`),
    video: v.ready,
  };
}

export { paths };
