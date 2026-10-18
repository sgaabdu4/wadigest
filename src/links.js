// URL extraction, canonicalisation (so the same link shared twice counts once) and titles.

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+|\b(?:www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'`]*/gi;

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|mc_cid|mc_eid|igshid|igsh|si|feature|ref|ref_src|ref_url|s|t|share_id|_hsenc|_hsmi|mkt_tok|trk|lipi|rcm|smid|cmpid)$/i;

export function extractUrls(text) {
  const found = String(text || '').match(URL_RE) || [];
  return found
    .map((u) => u.replace(/[)\].,;:!?*_~]+$/, '').replace(/^\(+/, ''))
    .map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`))
    .filter((u) => {
      try { new URL(u); return true; } catch { return false; }
    });
}

export function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{6,})/);
      if (m) return m[2];
    }
  } catch { /* not a URL */ }
  return null;
}

export function canonicalUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return String(raw || '').trim().toLowerCase(); }
  const yt = youtubeId(raw);
  if (yt) return `https://youtube.com/watch?v=${yt}`;
  let host = u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, '');
  if (host === 'twitter.com') host = 'x.com';
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? '?' + new URLSearchParams(params).toString() : '';
  let pathname = u.pathname.replace(/\/+$/, '');
  if (host === 'x.com') pathname = pathname.replace(/\/photo\/\d+$/, '');
  return `https://${host}${pathname}${query}`;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function isVideoLink(url) {
  const h = hostOf(url);
  return !!youtubeId(url) || /(^|\.)(tiktok\.com|vimeo\.com|loom\.com)$/.test(h) || /instagram\.com\/(reel|reels)\//.test(url);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => ENTITIES[n] ?? ENTITIES[n.toLowerCase()] ?? m);
}

function metaContent(html, names) {
  for (const name of names) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i');
    const m = html.match(re1) || html.match(re2);
    if (m && m[1].trim()) return decodeEntities(m[1]).trim();
  }
  return '';
}

export function parseHtmlMeta(html) {
  const title = metaContent(html, ['og:title', 'twitter:title']) ||
    decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const description = metaContent(html, ['og:description', 'twitter:description', 'description']);
  const siteName = metaContent(html, ['og:site_name']);
  return { title, description, siteName };
}

async function fetchWithTimeout(url, ms, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; wadigest/2.0; +https://github.com/openclaw/wacli)', 'accept-language': 'en', ...(opts.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Readable main text of a page: article/main if present, menus/scripts stripped. */
export function extractPageText(html, max = 2500) {
  let h = String(html || '');
  h = h.replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const pick = h.match(/<article[\s\S]*?<\/article>/i) || h.match(/<main[\s\S]*?<\/main>/i) || h.match(/<body[\s\S]*<\/body>/i);
  h = pick ? pick[0] : h;
  h = h.replace(/<(nav|header|footer|aside|form|button)[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<\/(p|div|li|h[1-6]|section|br|tr)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(h).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 30).join('\n');
  return text.slice(0, max);
}

/** Best-effort page info. Never throws; returns {} on failure. wantText adds a page excerpt for the AI modes. */
export async function fetchLinkInfo(url, { timeoutMs = 6000, fetchImpl, wantText = false } = {}) {
  const doFetch = fetchImpl || fetchWithTimeout;
  try {
    const oembed = youtubeId(url)
      ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`
      : /tiktok\.com/.test(hostOf(url))
        ? `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`
        : null;
    if (oembed) {
      const r = await doFetch(oembed, timeoutMs);
      if (r.ok) {
        const j = await r.json();
        if (j?.title) return { title: String(j.title).trim(), siteName: j.author_name ? `${j.provider_name || ''} · ${j.author_name}`.replace(/^ · /, '') : (j.provider_name || '') };
      }
    }
    const r = await doFetch(url, timeoutMs);
    if (!r.ok) return {};
    const type = r.headers.get('content-type') || '';
    if (!/html|xml/i.test(type)) return {};
    // Only the head matters; cap what we read.
    const reader = r.body?.getReader?.();
    let html = '';
    if (reader) {
      const dec = new TextDecoder();
      while (html.length < 300_000) {
        const { value, done } = await reader.read();
        if (done) break;
        html += dec.decode(value, { stream: true });
        if (!wantText && /<\/head>/i.test(html)) break;
      }
      try { await reader.cancel(); } catch { /* ignore */ }
    } else {
      html = (await r.text()).slice(0, 300_000);
    }
    const meta = parseHtmlMeta(html);
    if (wantText) meta.excerpt = extractPageText(html);
    // Ignore useless generic titles.
    if (/^(just a moment|attention required|access denied|log in|sign in|403|404)/i.test(meta.title)) return {};
    return meta;
  } catch {
    return {};
  }
}
