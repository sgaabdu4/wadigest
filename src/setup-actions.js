// Install / detect helpers shared by the setup page and the terminal wizard.

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import crypto from 'node:crypto';
import { DEFAULT_LOCAL_MODEL, LLAMA_BUILDS, MODELS, BUILD_URL, platformKey, llmDir, serverBin, localReady, modelInfo } from './local.js';
import { detectVideoTools, defaultWhisperModel } from './video.js';

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

async function sha256Of(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function fetchChecked(url, file, sha256, onLog) {
  if (fs.existsSync(file) && (await sha256Of(file)) === sha256) return;
  await download(url, file, onLog);
  if ((await sha256Of(file)) !== sha256) {
    fs.rmSync(file, { force: true });
    throw new Error(`${path.basename(file)} failed its checksum check. Try again.`);
  }
}

/** The bundled local AI: llama.cpp's server program plus one small model, into ~/.wadigest/llm. */
export async function installLocalAI({ model = DEFAULT_LOCAL_MODEL, onLog = () => {} } = {}) {
  const build = LLAMA_BUILDS[platformKey()];
  if (!build) throw new Error(`Local AI isn't available for this computer (${platformKey()}). Choose “simply” or “with Claude”.`);
  const info = MODELS[model] || MODELS[DEFAULT_LOCAL_MODEL];
  const dir = llmDir();
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  if (!serverBin()) {
    onLog('Getting the local AI program (about 15 MB)…');
    const archive = path.join(dir, build[0]);
    await fetchChecked(`${BUILD_URL}/${build[0]}`, archive, build[1], onLog);
    await runStreaming('tar', ['-xf', archive, '-C', path.join(dir, 'bin')], onLog);
    fs.rmSync(archive, { force: true });
    if (!serverBin()) throw new Error('The local AI program did not unpack correctly. Try again.');
    if (process.platform !== 'win32') fs.chmodSync(serverBin(), 0o755);
  }
  onLog(`Getting the ${info.label} model (about ${info.mb} MB, one time)…`);
  await fetchChecked(info.url, path.join(dir, info.file), info.sha256, onLog);
  onLog(`✓ Local AI ready (${info.label})`);
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
  const v = await detectVideoTools(cfg);
  const ready = localReady(cfg);
  return { model: modelInfo(cfg).label, modelReady: ready, video: v.ready };
}

export { paths };
