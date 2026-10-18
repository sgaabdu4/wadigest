// The setup page / control panel. `wadigest` (or `wadigest setup`) starts a tiny server on
// 127.0.0.1 with a random secret in the URL and opens it in the browser.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureConfig, loadConfig, saveConfig, loadState, setConfigValue, paths, groupConfig } from './config.js';
import { Wacli } from './wacli.js';
import { findGroups } from './groups.js';
import { setGroups } from './reset.js';
import { installService, serviceStatus, stopServiceIfRunning } from './service.js';
import { loadMembers } from './members.js';
import { nextSlot, rollingWindow, readDays, everyDays, describeSchedule, applySchedule } from './schedule.js';
import { prepareDigest, runGroupNow } from './pipeline.js';
import { renderGroupPost } from './format.js';
import { normalizePhone } from './util.js';
import { loadSecrets, saveSecrets } from './config.js';
import { detectClaude, installLocalAI, installVideo, localStatus, runStreaming } from './setup-actions.js';
import { LLAMA_BUILDS, platformKey, localReady } from './local.js';

const HTML_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui', 'index.html');
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const installerDone = () => !!process.env.WADIGEST_WACLI || fs.existsSync(path.join(paths().home, 'installed'));

function runInstaller(onLog) {
  if (process.platform === 'win32') {
    return runStreaming('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(APP_DIR, 'scripts', 'install.ps1'), '-NoSetup'], onLog);
  }
  return runStreaming('bash', [path.join(APP_DIR, 'scripts', 'install.sh'), '--from-ui'], onLog);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, () => {});
}

function fmtWhen(d, tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(d);
}

export async function runSetupUI({ open = true, port = 0 } = {}) {
  ensureConfig();
  const token = crypto.randomBytes(16).toString('hex');
  const base = `/s/${token}`;
  let cfg = loadConfig();
  let wacli = new Wacli(cfg);

  // The background service holds wacli's store lock; pause it while this page is open.
  // During first setup the page needs WhatsApp's connection (linking). Once set up, the service keeps
  // running so it can answer members; it is paused only to link a different account or to send.
  let serviceWasRunning = cfg.setupDone ? false : stopServiceIfRunning();
  let finished = false;

  const link = { status: 'idle', kind: '', code: '', qr: '', error: '', messages: 0, child: null };
  const job = { running: false, log: [], error: '' };
  const run = { running: false, done: 0, total: 0, log: [], error: '' };
  // The local AI is a big download, so first setup starts it while the user links WhatsApp and picks groups.
  let localDl = null;
  let localLog = () => {};
  const prefetchLocal = () => {
    if (!localDl) {
      localDl = installLocalAI({ model: loadConfig().local?.model, onLog: (l) => localLog(l) }).catch((e) => { localDl = null; throw e; });
      localDl.catch(() => {});
    }
    return localDl;
  };
  const maybePrefetchLocal = () => {
    const c = loadConfig();
    if (!c.setupDone && installerDone() && LLAMA_BUILDS[platformKey()] && !localReady(c)) prefetchLocal();
  };
  let groupsCache = null;
  let refreshed = false;

  const authStatus = async () => {
    try { return await wacli.authStatus(); } catch (e) { return { authenticated: false, error: e.message }; }
  };

  const loadGroups = async (force = false) => {
    if (link.child) return []; // linking in progress owns the store
    if (!groupsCache || force) groupsCache = await wacli.groups('').catch(() => []);
    if ((!groupsCache.length || force) && !refreshed) {
      refreshed = true;
      try { await wacli.refreshGroups(); } catch { /* keep stored list */ }
      groupsCache = await wacli.groups('').catch(() => []);
    }
    return groupsCache;
  };

  const startLink = (phone) => {
    if (stopServiceIfRunning()) serviceWasRunning = true;
    if (link.child) link.child.kill('SIGINT');
    Object.assign(link, { status: 'starting', kind: phone ? 'code' : 'qr', code: '', qr: '', error: '', messages: 0 });
    const child = wacli.linkWithEvents({
      phone,
      logFile: path.join(paths().logs, 'link.log'),
      onEvent: (ev) => {
        if (ev.event === 'pair_code') { link.code = String(ev.data?.code || ''); link.status = 'waiting'; }
        else if (ev.event === 'qr_code') { link.qr = String(ev.data?.code || ''); link.status = 'waiting'; }
        else if (ev.event === 'connected') link.status = 'syncing';
        else if (ev.event === 'progress' && link.status === 'syncing') {
          const n = Number(ev.data?.messages_synced ?? ev.data?.messages ?? ev.data?.count ?? ev.data?.stored ?? 0);
          if (n) link.messages = n;
        } else if (ev.event === 'error') link.error = String(ev.data?.message || ev.data?.error || 'WhatsApp reported an error');
      },
    });
    link.child = child;
    child.on('error', (e) => { link.status = 'error'; link.error = e.code === 'ENOENT' ? 'wacli is not installed. Run scripts/install.sh first.' : e.message; link.child = null; });
    child.on('exit', async (code) => {
      if (link.child !== child) return;
      link.child = null;
      const st = await authStatus();
      if (st.authenticated) {
        link.status = 'done';
        groupsCache = null;
        refreshed = false;
      } else if (link.status !== 'cancelled') {
        link.status = 'error';
        link.error ||= code === 0 ? 'Linking did not finish. Try again.' : 'The code expired or linking was cancelled on the phone. Try again.';
      }
    });
  };

  const snapshot = async () => {
    cfg = loadConfig();
    const st = link.child ? { authenticated: false } : await authStatus();
    const state = loadState();
    const tz = cfg.schedule.timezone;
    const now = new Date();
    const lastPost = Object.entries(state.posted || {}).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))[0];
    const members = loadMembers();
    return {
      ready: installerDone(),
      platform: process.platform,
      linked: !!st.authenticated,
      phone: st.phone || '',
      link: { status: link.status, kind: link.kind, code: link.code, qr: link.qr, error: link.error, messages: link.messages },
      groups: cfg.groups,
      schedule: { ...cfg.schedule, everyDays: everyDays(cfg.schedule), readDays: readDays(cfg.schedule), text: describeSchedule(cfg.schedule) },
      nextRun: fmtWhen(nextSlot(now, cfg.schedule), tz),
      run: { running: run.running, done: run.done, total: run.total, log: run.log.slice(-8), error: run.error },
      members: members.filter((m) => m.active).length,
      lastPost: lastPost ? { week: lastPost[0], at: fmtWhen(new Date(lastPost[1].at), tz), dms: lastPost[1].dms?.sent ?? null } : null,
      service: finished ? serviceStatus() : (serviceWasRunning ? 'paused while this page is open' : serviceStatus()),
      pauses: !cfg.setupDone,
      finished,
      setupDone: !!cfg.setupDone,
      mode: cfg.mode,
      topN: cfg.topN,
      audience: cfg.dms?.enabled === false ? 'off' : (cfg.dms?.audience || 'everyone'),
      pin: cfg.pin?.enabled !== 'off' && await wacli.supportsPin().catch(() => false),
      timezones: typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [tz],
    };
  };

  const readBody = (req) => new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });

  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };

  let closeResolve;
  const closed = new Promise((r) => { closeResolve = r; });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith(base)) return send(res, 404, 'Not found', 'text/plain');
      // Only accept same-origin writes (blocks other sites in the browser from poking this).
      if (req.method === 'POST') {
        const origin = req.headers.origin || '';
        if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return send(res, 403, { error: 'forbidden' });
      }
      const route = url.pathname.slice(base.length) || '/';

      if (route === '/' && req.method === 'GET') return send(res, 200, fs.readFileSync(HTML_FILE, 'utf8'), 'text/html; charset=utf-8');
      if (route === '/api/state') return send(res, 200, await snapshot());

      if (route === '/api/link' && req.method === 'POST') {
        const body = await readBody(req);
        const phone = normalizePhone(body.phone || '');
        if (body.phone && (phone.length < 8 || phone.length > 15)) return send(res, 400, { error: 'That number looks too short or too long. Include the country code, like +44 7700 900123.' });
        if (body.fresh) {
          // Linking a different number: forget the current one first.
          await wacli.run(['auth', 'logout'], { timeoutMs: 60_000 }).catch(() => {});
        }
        startLink(phone);
        return send(res, 200, { ok: true });
      }
      if (route === '/api/link/cancel' && req.method === 'POST') {
        if (link.child) { link.status = 'cancelled'; link.child.kill('SIGINT'); }
        link.status = 'idle';
        return send(res, 200, { ok: true });
      }

      if (route === '/api/groups' && req.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        let groups = await loadGroups();
        if (!q) return send(res, 200, { total: groups.length, matches: [...groups].sort((x, y) => x.name.localeCompare(y.name)).map((g) => ({ jid: g.jid, name: g.name })) });
        let matches = findGroups(groups, q);
        if (!matches.length && q && !refreshed) {
          groups = await loadGroups(true);
          matches = findGroups(groups, q);
        }
        return send(res, 200, { total: groups.length, matches: matches.slice(0, 25).map((g) => ({ jid: g.jid, name: g.name })) });
      }

      if (route === '/api/groups' && req.method === 'POST') {
        const body = await readBody(req);
        const known = await loadGroups();
        const picked = [];
        for (const p of Array.isArray(body.groups) ? body.groups : []) {
          const g = known.find((x) => x.jid === p.jid);
          if (!g) return send(res, 400, { error: `"${p.name || 'A group'}" isn't on this WhatsApp any more. Search again.` });
          picked.push({ jid: g.jid, name: g.name, post: p.post, pin: p.pin, dm: p.dm });
        }
        if (!picked.length) return send(res, 400, { error: 'Pick at least one group.' });
        setGroups(loadConfig(), picked);
        return send(res, 200, { ok: true });
      }

      if (route === '/api/schedule' && req.method === 'POST') {
        const body = await readBody(req);
        const c = loadConfig();
        try { applySchedule(c, body); } catch (e) { return send(res, 400, { error: e.message }); }
        saveConfig(c);
        return send(res, 200, { ok: true });
      }

      if (route === '/api/mode' && req.method === 'GET') {
        const c = loadConfig();
        const [claude, local] = await Promise.all([detectClaude(), localStatus(c)]);
        return send(res, 200, {
          mode: c.mode, platform: process.platform,
          claude: { cli: claude.cli, key: !!(process.env.ANTHROPIC_API_KEY || loadSecrets().anthropicApiKey) },
          local: { ready: local.modelReady, model: local.model, video: local.video },
        });
      }
      if (route === '/api/mode' && req.method === 'POST') {
        const body = await readBody(req);
        const c = loadConfig();
        try { setConfigValue(c, 'mode', String(body.mode || 'digest')); } catch (e) { return send(res, 400, { error: e.message }); }
        c.video.enabled = body.video ? 'auto' : 'off';
        if (body.apiKey) {
          if (!String(body.apiKey).startsWith('sk-')) return send(res, 400, { error: "That doesn't look like an Anthropic API key." });
          saveSecrets({ ...loadSecrets(), anthropicApiKey: String(body.apiKey).trim() });
        }
        saveConfig(c);
        return send(res, 200, { ok: true });
      }
      if (route === '/api/install' && req.method === 'POST') {
        const body = await readBody(req);
        if (job.running) return send(res, 200, { ok: true });
        Object.assign(job, { running: true, log: [], error: '' });
        const onLog = (l) => { job.log.push(l); if (job.log.length > 400) job.log.splice(0, 100); };
        (async () => {
          try {
            if (body.local) {
              localLog = onLog;
              try { await prefetchLocal(); } finally { localLog = () => {}; }
            }
            if (body.video) await installVideo({ onLog });
          } catch (e) { job.error = e.message; onLog(`✖ ${e.message}`); }
          job.running = false;
        })();
        return send(res, 200, { ok: true });
      }
      if (route === '/api/prepare' && req.method === 'POST') {
        if (job.running) return send(res, 200, { ok: true });
        Object.assign(job, { running: true, log: [], error: '' });
        const onLog = (l) => { job.log.push(l.replace(/\x1b\[[0-9;]*m/g, '')); if (job.log.length > 400) job.log.splice(0, 100); };
        (async () => {
          try {
            await runInstaller(onLog);
            if (!installerDone()) throw new Error('The install stopped before it finished.');
            wacli = new Wacli(loadConfig());
            maybePrefetchLocal();
          } catch (e) { job.error = e.message; onLog(`✖ ${e.message}`); }
          job.running = false;
        })();
        return send(res, 200, { ok: true });
      }
      if (route === '/api/job') return send(res, 200, job);
      if (route === '/api/audience' && req.method === 'POST') {
        const body = await readBody(req);
        const c = loadConfig();
        try { setConfigValue(c, 'dms.audience', String(body.audience)); } catch (e) { return send(res, 400, { error: e.message }); }
        c.dms.enabled = c.dms.audience !== 'off';
        saveConfig(c);
        return send(res, 200, { ok: true });
      }

      if (route === '/api/preview') {
        const c = loadConfig();
        if (!c.groups.length) return send(res, 400, { error: 'Pick a group first.' });
        const state = loadState();
        const out = [];
        for (const g of c.groups) {
          const gc = groupConfig(c, g);
          const { digest, messages } = await prepareDigest({ cfg: gc, state, wacli: new Wacli(c), window: rollingWindow(new Date(), readDays(c.schedule)), videos: false });
          out.push({ name: g.name, messages, text: renderGroupPost(digest, { timeZone: c.schedule.timezone, audience: gc.dms.audience }) });
        }
        return send(res, 200, { previews: out });
      }

      if (route === '/api/run' && req.method === 'POST') {
        const c = loadConfig();
        if (!c.groups.length) return send(res, 400, { error: 'Pick a group first.' });
        if (run.running) return send(res, 200, { ok: true });
        Object.assign(run, { running: true, done: 0, total: c.groups.length, log: [], error: '' });
        (async () => {
          // Sending needs WhatsApp's connection, which the background service holds: pause it for the run.
          const was = stopServiceIfRunning();
          const state = loadState();
          for (const g of c.groups) {
            try {
              run.log.push(`${g.name}: reading messages`);
              const onProgress = (t) => run.log.push(`${g.name}: ${t}`);
              let n = 0;
              const r = await runGroupNow({ cfg: c, group: g, state, wacli: new Wacli(c), onProgress, onDm: (m, ok) => run.log.push(`${g.name}: ${ok ? 'sent' : 'could not send'} private message ${++n}`) });
              run.log.push(`${g.name}: done${r.group ? ', posted' : ''}${r.pinned ? ' and pinned' : ''}${g.dm !== false ? `, ${r.dms.filter((d) => d.ok).length} DMs sent` : ''}`);
            } catch (e) { run.error = `${g.name}: ${e.message}`; run.log.push(run.error); }
            run.done++;
          }
          if (was || finished) { try { installService(loadConfig()); } catch (e) { run.log.push(`Couldn't restart the background service: ${e.message}`); } }
          run.running = false;
        })();
        return send(res, 200, { ok: true });
      }

      if (route === '/api/start' && req.method === 'POST') {
        const c = loadConfig();
        if (!c.groups.length) return send(res, 400, { error: 'Pick a group first.' });
        try {
          c.setupDone = true;
          saveConfig(c);
          installService(c);
          finished = true;
        } catch (e) { return send(res, 500, { error: `Couldn't start the background service: ${e.message}` }); }
        return send(res, 200, { ok: true, service: serviceStatus() });
      }

      if (route === '/api/close' && req.method === 'POST') {
        send(res, 200, { ok: true });
        setTimeout(() => closeResolve(), 200);
        return;
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}${base}/`;
  console.log(`\n  wadigest is open in your browser.\n  If it didn't open, paste this into your browser:\n\n    ${url}\n\n  Keep this window open until you press "Start" on the page. (Ctrl+C to quit.)\n`);
  if (open) openBrowser(url);
  maybePrefetchLocal();

  const onSig = () => closeResolve();
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  await closed;
  process.off('SIGINT', onSig);
  process.off('SIGTERM', onSig);
  if (link.child) link.child.kill('SIGINT');
  server.close();
  // Leave things as we found them: if the page didn't start the service, restart it if it was running.
  if (!finished && serviceWasRunning && loadConfig().groups.length) {
    try { installService(loadConfig()); } catch { /* ignore */ }
  }
  console.log(finished ? '  ✅ wadigest is running in the background. You can close this window.\n' : '  Closed.\n');
}
