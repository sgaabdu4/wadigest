// Optional: transcribe videos uploaded to the group so the digest can say what's in them.
// Uses tools already on the machine, nothing bundled:
//   ffmpeg            (brew install ffmpeg)
//   whisper-cli       (brew install whisper-cpp) + a ggml model file, or
//   whisper           (pip install openai-whisper)
// The downloaded video and audio are deleted straight after.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { log } from './log.js';

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function has(bin) {
  try {
    await run(bin, bin === 'ffmpeg' ? ['-version'] : ['--help'], 15_000);
    return true;
  } catch (err) {
    return err.code !== 'ENOENT' && typeof err.code !== 'string';
  }
}

export function defaultWhisperModel() {
  return path.join(paths().home, 'models', 'ggml-base.bin');
}

/** Which transcriber is available, if any. */
export async function detectVideoTools(cfg) {
  const ffmpeg = await has('ffmpeg');
  const model = cfg.video?.whisperModel || defaultWhisperModel();
  let whisper = null;
  if (await has('whisper-cli')) {
    if (fs.existsSync(model)) whisper = { kind: 'whisper.cpp', bin: 'whisper-cli', model };
  }
  if (!whisper && (await has('whisper'))) whisper = { kind: 'openai-whisper', bin: 'whisper', model: cfg.video?.whisperModel || 'base' };
  return { ffmpeg, whisper, ready: ffmpeg && !!whisper, modelPath: model };
}

export async function videoEnabled(cfg) {
  const mode = String(cfg.video?.enabled || 'auto');
  if (mode === 'off') return { on: false, why: 'video.enabled is off' };
  const tools = await detectVideoTools(cfg);
  if (!tools.ready) {
    const missing = [!tools.ffmpeg && 'ffmpeg', !tools.whisper && 'whisper-cli + model (or whisper)'].filter(Boolean).join(', ');
    return { on: false, why: `missing ${missing}`, tools };
  }
  return { on: true, tools };
}

/** Download, extract audio (first 10 min), transcribe, clean up. Returns transcript text. */
export async function transcribeVideo(wacli, chatJid, msgId, tools) {
  const dir = path.join(paths().tmp, `video-${msgId.replace(/[^\w-]/g, '')}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const videoFile = path.join(dir, 'video.mp4');
  const audioFile = path.join(dir, 'audio.wav');
  try {
    const got = await wacli.downloadMedia(chatJid, msgId, videoFile);
    const input = fs.existsSync(videoFile) ? videoFile : got;
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-t', '600', audioFile], 5 * 60_000);
    let text = '';
    if (tools.whisper.kind === 'whisper.cpp') {
      const base = path.join(dir, 'transcript');
      await run(tools.whisper.bin, ['-m', tools.whisper.model, '-f', audioFile, '-otxt', '-of', base, '-np', '-l', 'auto'], 20 * 60_000);
      text = fs.readFileSync(base + '.txt', 'utf8');
    } else {
      await run(tools.whisper.bin, [audioFile, '--model', tools.whisper.model, '--output_format', 'txt', '--output_dir', dir, '--fp16', 'False'], 30 * 60_000);
      text = fs.readFileSync(path.join(dir, 'audio.txt'), 'utf8');
    }
    return text.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Transcribe any not-yet-seen videos among `messages`. Records results in state.videos. */
export async function processVideos(wacli, cfg, state, messages, { max = 5, kinds = ['video'] } = {}) {
  const status = await videoEnabled(cfg);
  if (!status.on) return { processed: 0, skipped: status.why };
  state.videos ||= {};
  const todo = messages.filter((m) => kinds.includes(String(m.MediaType).toLowerCase()) && !m.Revoked && !state.videos[m.MsgID]).slice(-max);
  let processed = 0;
  for (const m of todo) {
    try {
      const transcript = await transcribeVideo(wacli, m.ChatJID, m.MsgID, status.tools);
      state.videos[m.MsgID] = { at: new Date().toISOString(), transcript };
      processed++;
      log.info(`Transcribed video ${m.MsgID} (${transcript.length} chars)`);
    } catch (err) {
      state.videos[m.MsgID] = { at: new Date().toISOString(), error: String(err.message || err).slice(0, 300) };
      log.warn(`Could not transcribe video ${m.MsgID}: ${err.message}`);
    }
  }
  return { processed };
}
