'use strict';

const express = require('express');
const crypto = require('crypto');
const { Readable } = require('stream');

const JF = (process.env.JELLYFIN_URL || 'http://jellyfin:8096').replace(/\/+$/, '');
const KEY = process.env.JELLYFIN_API_KEY;
const COLLECTION_ID = process.env.WATCH_COLLECTION_ID;
const PORT = parseInt(process.env.PORT || '3000', 10);
const SCOPE_TTL_MS = 5 * 60 * 1000;

if (!KEY) throw new Error('JELLYFIN_API_KEY is required');
if (!COLLECTION_ID) throw new Error('WATCH_COLLECTION_ID is required');

// ---------------------------------------------------------------------------
// Jellyfin helpers
// ---------------------------------------------------------------------------
function jfUrl(path, query = {}) {
  const u = new URL(JF + (path.startsWith('/') ? path : '/' + path));
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, v);
  }
  u.searchParams.set('api_key', KEY);
  return u;
}

async function jfJson(path, query = {}) {
  const res = await fetch(jfUrl(path, query), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jellyfin ${path} -> ${res.status}`);
  return res.json();
}

// Fetch a single item's metadata. The bare /Items/{id} route 500s on this
// server (it wants a user context), so go through the list endpoint instead.
async function jfItem(id, fields = '') {
  const data = await jfJson('/Items', { Ids: id, Fields: fields });
  return (data.Items || [])[0] || {};
}

// ---------------------------------------------------------------------------
// Scope cache: what is publicly viewable, derived from the Public collection.
//   collectionItems : direct children (movies + series) -> for browse pages
//   playableIds     : movie ids + every episode id      -> for the play guard
// ---------------------------------------------------------------------------
let collectionItems = [];
let playableIds = new Set();
let scopeLoadedAt = 0;
let scopeLoading = null;

async function refreshScope() {
  // BoxSet membership only resolves with Recursive=true; constrain to the
  // top-level member types so we get Movies/Series, not their episodes.
  const children = await jfJson('/Items', {
    ParentId: COLLECTION_ID,
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    Fields: 'PrimaryImageAspectRatio,ProductionYear,Genres,OriginalTitle',
  });
  const items = children.Items || [];
  const playable = new Set();

  for (const it of items) {
    if (it.Type === 'Series') {
      const eps = await jfJson(`/Shows/${it.Id}/Episodes`, { Fields: 'Overview' });
      for (const ep of eps.Items || []) playable.add(ep.Id);
    } else {
      // Movie (or any directly-playable leaf)
      playable.add(it.Id);
    }
  }

  collectionItems = items;
  playableIds = playable;
  scopeLoadedAt = Date.now();
}

async function ensureScope() {
  if (Date.now() - scopeLoadedAt < SCOPE_TTL_MS && playableIds.size >= 0 && scopeLoadedAt) {
    return;
  }
  if (!scopeLoading) {
    scopeLoading = refreshScope().finally(() => { scopeLoading = null; });
  }
  await scopeLoading;
}

const isCollectionItem = (id) => collectionItems.some((it) => it.Id === id);

// ---------------------------------------------------------------------------
// Byte-streaming proxy to Jellyfin (used for images, playlists, segments)
// ---------------------------------------------------------------------------
// Jellyfin embeds the api_key inside playlist URIs. Strip every api_key/ApiKey
// param so the viewer never sees the token; the catch-all re-adds it server-side
// when the (relative) URI comes back through us. Relative paths are preserved.
function stripCreds(m3u8) {
  return m3u8
    .replace(/&(?:api_key|ApiKey)=[^&\r\n"']*/gi, '')          // mid/end param
    .replace(/\?(?:api_key|ApiKey)=[^&\r\n"']*&/gi, '?')       // first of several
    .replace(/\?(?:api_key|ApiKey)=[^&\r\n"']*/gi, '');        // only param
}

async function proxy(req, res, url, { isPlaylist = false } = {}) {
  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;

  let upstream;
  try {
    upstream = await fetch(url, { headers });
  } catch (err) {
    res.status(502).type('text').send('upstream error');
    return;
  }

  const ct = upstream.headers.get('content-type') || '';
  const playlist = isPlaylist || /mpegurl/i.test(ct);

  if (playlist) {
    const body = stripCreds(await upstream.text());
    res.status(upstream.status);
    res.set('content-type', ct || 'application/vnd.apple.mpegurl');
    res.set('cache-control', 'no-store');
    res.send(body);
    return;
  }

  res.status(upstream.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = upstream.headers.get(h);
    if (v) res.set(h, v);
  }
  if (!upstream.body) { res.end(); return; }
  Readable.fromWeb(upstream.body).pipe(res);
}

// ---------------------------------------------------------------------------
// HTML rendering — "Kagura" design language: dark, violet-accent, poster-forward
// (ported from the design-plan: tokens.css + components.css + series/library)
// ---------------------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Inline icon helper (subset of the design's shared.js icon set)
const ICONS = {
  play:    '<polygon points="6 3 20 12 6 21 6 3"/>',
  back:    '<path d="m15 18-6-6 6-6"/>',
  fwd:     '<path d="m9 18 6-6-6-6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  tag:     '<path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.4"/>',
  search:  '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v4M16 3v4"/>',
  tv:      '<rect x="2" y="7" width="20" height="15" rx="2"/><path d="m17 2-5 5-5-5"/>',
  film:    '<rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>',
  audio:   '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/>',
  captions:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 11h3M7 14.5h5M14 11h3M14.5 14.5h2.5"/>',
  gear:    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  theater: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
  shrink:  '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M16 21v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>',
  next:    '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/>',
};
const svg = (name, size = 16, fill = 'none') =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;

// Design tokens + the slice of components used by the watch pages.
const STYLE = `
  :root {
    color-scheme: dark;
    --font-sans: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --font-mono: "Geist Mono", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
    --bg:            oklch(0.145 0.008 285);
    --bg-elev:       oklch(0.185 0.01  285);
    --bg-elev-2:     oklch(0.22  0.012 285);
    --bg-hover:      oklch(0.25  0.015 285);
    --fg:            oklch(0.985 0.003 285);
    --fg-muted:      oklch(0.72  0.012 285);
    --fg-subtle:     oklch(0.55  0.012 285);
    --border:        oklch(1 0 0 / 8%);
    --border-strong: oklch(1 0 0 / 14%);
    --ring:          oklch(0.72 0.18 310);
    --accent:        oklch(0.72 0.18 310);
    --accent-hover:  oklch(0.78 0.18 310);
    --accent-fg:     oklch(0.145 0.008 285);
    --accent-soft:   oklch(0.72 0.18 310 / 12%);
    --accent-soft-fg:oklch(0.82 0.18 310);
    --success:       oklch(0.78 0.17 160);
    --info:          oklch(0.75 0.14 240);
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--fg); }
  body { margin:0; font:15px/1.55 var(--font-sans); font-feature-settings:"cv11","ss01"; -webkit-font-smoothing:antialiased; }
  a { color: inherit; text-decoration: none; }
  .font-mono { font-family: var(--font-mono); }
  .icon { flex-shrink: 0; }
  ::selection { background: var(--accent-soft); color: var(--accent-soft-fg); }
  *::-webkit-scrollbar { width:10px; height:10px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb { background: oklch(1 0 0 / 8%); border-radius:10px; border:2px solid transparent; background-clip:padding-box; }
  *::-webkit-scrollbar-thumb:hover { background: oklch(1 0 0 / 16%); }

  /* Chrome / header — brand left, centered search, crumb right */
  .chrome {
    position: sticky; top: 0; z-index: 50;
    display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 520px) minmax(0, 1fr);
    align-items: center; gap: 14px;
    padding: 0 24px; height: 56px;
    background: oklch(0.145 0.008 285 / 80%); backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border);
  }
  .chrome .brand { grid-column: 1; justify-self: start; display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 14px; }
  .chrome .brand-mark {
    width: 26px; height: 26px; border-radius: 7px; flex-shrink: 0;
    background: linear-gradient(135deg, var(--accent), oklch(0.62 0.2 270));
    display: grid; place-items: center;
    font-family: var(--font-mono); font-size: 13px; color: var(--accent-fg); font-weight: 600;
  }
  .chrome .brand .label { white-space: nowrap; }
  .chrome .brand .sub { color: var(--fg-subtle); font-weight: 500; }
  .chrome .chrome-right { grid-column: 3; justify-self: end; }
  .chrome .crumb { color: var(--fg-muted); font-size: 13px; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .chrome .crumb:hover { color: var(--fg); }

  /* Advanced search bar (ported from the design's command palette field) */
  .searchbar {
    grid-column: 2; position: relative; display: flex; align-items: center; width: 100%; height: 40px;
    background: var(--bg-elev-2); border: 1px solid var(--border); border-radius: 9px;
    transition: border-color .14s ease, background .14s ease, box-shadow .14s ease;
  }
  .searchbar:hover { border-color: var(--border-strong); }
  .searchbar:focus-within { border-color: var(--accent); background: var(--bg-elev); box-shadow: 0 0 0 3px var(--accent-soft); }
  .searchbar .search-icon { display: flex; align-items: center; padding: 0 8px 0 13px; color: var(--fg-subtle); }
  .searchbar:focus-within .search-icon { color: var(--accent-soft-fg); }
  .searchbar .search-input {
    flex: 1; min-width: 0; height: 100%; padding: 0 4px; border: none; outline: none;
    background: transparent; color: var(--fg); font: 13.5px var(--font-sans);
  }
  .searchbar .search-input::placeholder { color: var(--fg-subtle); }
  .searchbar .search-input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
  .searchbar .search-kbd { display: flex; align-items: center; padding: 0 10px 0 6px; }
  .kbd {
    display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px;
    padding: 0 5px; border-radius: 4px; font-family: var(--font-mono); font-size: 10px; color: var(--fg-muted);
    background: var(--bg-elev); border: 1px solid var(--border); border-bottom-width: 2px;
  }

  /* Search results dropdown (command-palette result rows from the design) */
  .search-results {
    position: absolute; top: calc(100% + 8px); left: 0; right: 0; z-index: 60;
    background: var(--bg-elev); border: 1px solid var(--border); border-radius: 12px;
    box-shadow: 0 30px 80px -20px oklch(0 0 0 / 70%);
    max-height: min(70vh, 460px); overflow-y: auto;
  }
  .sr-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .sr-row:last-child { border-bottom: none; }
  .sr-row:hover, .sr-row[data-active="true"] { background: var(--bg-elev-2); }
  .sr-thumb {
    position: relative; width: 40px; height: 58px; border-radius: 5px; overflow: hidden; flex-shrink: 0;
    display: grid; place-items: center;
    background: linear-gradient(135deg, oklch(0.26 0.06 310) 0%, oklch(0.16 0.03 285) 100%);
  }
  .sr-thumb span { font-family: var(--font-mono); font-size: 10px; color: oklch(1 0 0 / 55%); }
  .sr-thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .sr-main { min-width: 0; flex: 1; }
  .sr-title { font-size: 13.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sr-meta { font-size: 11px; color: var(--fg-subtle); margin-top: 3px; }
  .sr-go { flex-shrink: 0; display: flex; color: var(--fg-subtle); }
  .sr-row:hover .sr-go, .sr-row[data-active="true"] .sr-go { color: var(--accent-soft-fg); }
  .sr-empty { padding: 18px 16px; color: var(--fg-subtle); font-size: 13px; }

  /* Buttons */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    height: 40px; padding: 0 18px; border-radius: 9px; font-size: 14px; font-weight: 500;
    border: 1px solid transparent; cursor: pointer; text-decoration: none; white-space: nowrap;
    transition: background .14s ease, border-color .14s ease, transform .08s ease;
  }
  .btn:active { transform: translateY(0.5px); }
  .btn-primary { background: var(--accent); color: var(--accent-fg); }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-secondary { background: var(--bg-elev-2); color: var(--fg); border-color: var(--border); }
  .btn-secondary:hover { background: var(--bg-hover); border-color: var(--border-strong); }
  .btn-icon { width: 40px; padding: 0; }
  .btn.disabled { opacity: 0.4; pointer-events: none; }

  /* Week navigation toolbar */
  .cal-nav { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; }
  .cal-range { font-family: var(--font-mono); font-size: 13px; color: var(--fg-muted); margin-left: 4px; }

  /* Schedule — week view (ported from the design's calendar) */
  .cal-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  .cal-stat { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
  .cal-stat .v { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin-top: 4px; }
  .cal-stat .s { font-size: 11px; color: var(--fg-subtle); margin-top: 2px; }
  .cal-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-elev); }
  .cal-week { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); min-width: 1085px; }
  .cal-day { border-right: 1px solid var(--border); min-height: 360px; display: flex; flex-direction: column; }
  .cal-day:last-child { border-right: none; }
  .cal-day-head { padding: 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
  .cal-day.today .cal-day-head { background: var(--bg-elev-2); }
  .cal-day.today .cal-date { color: var(--accent); }
  .cal-dow { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--fg-subtle); }
  .cal-date { font-family: var(--font-mono); font-size: 13px; font-weight: 500; margin-top: 2px; }
  .cal-events { padding: 10px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
  .cal-empty { margin: auto; font-size: 11px; color: var(--fg-subtle); }
  .evt { position: relative; border-radius: 10px; background: var(--bg); border: 1px solid var(--border); overflow: hidden; }
  .evt.now { border-color: var(--accent); }
  .evt.now::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: var(--accent); z-index: 1; }
  .evt.aired { opacity: 0.62; }
  .evt-main { display: block; }
  .evt-thumb { position: relative; width: 100%; height: 84px; overflow: hidden;
    background: linear-gradient(135deg, oklch(0.26 0.06 310), oklch(0.16 0.03 285)); }
  .evt-thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center 30%; }
  .evt-body { min-width: 0; padding: 9px 10px; display: flex; flex-direction: column; gap: 6px; }
  .evt-title { font-size: 12px; font-weight: 500; line-height: 1.3; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .evt-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 6px; }
  .evt-time { font-family: var(--font-mono); font-size: 11px; color: var(--fg-muted); }
  .evt-label { font-size: 10px; color: var(--fg-subtle); }
  .evt-label.up { color: var(--info); }
  .lang { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 4px;
    font-family: var(--font-mono); font-size: 9px; font-weight: 600; letter-spacing: 0.06em; border: 1px solid transparent; }
  .lang-sub { background: oklch(0.75 0.14 240 / 16%); color: oklch(0.82 0.13 240); }   /* blue */
  .lang-dub { background: oklch(0.78 0.17 160 / 16%); color: var(--success); }          /* green */
  .lang-raw { background: var(--bg-elev-2); color: var(--fg-subtle); }                   /* native / JPN */

  /* Day selector — only shown on mobile (one day at a time) */
  .cal-tabs { display: none; gap: 6px; overflow-x: auto; padding-bottom: 4px; margin-bottom: 14px; -webkit-overflow-scrolling: touch; }
  .cal-tab { flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 1px;
    min-width: 54px; padding: 8px 10px; border-radius: 10px; background: var(--bg-elev-2);
    border: 1px solid var(--border); cursor: pointer; font: inherit; }
  .cal-tab .d { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--fg-subtle); }
  .cal-tab .n { font-family: var(--font-mono); font-size: 15px; font-weight: 600; color: var(--fg); }
  .cal-tab .c { font-size: 9px; color: var(--fg-subtle); }
  .cal-tab.today .n { color: var(--accent); }
  .cal-tab[data-active="true"] { border-color: var(--accent); background: var(--accent-soft); }
  .cal-tab[data-active="true"] .n, .cal-tab[data-active="true"] .d { color: var(--accent-soft-fg); }

  @media (max-width: 700px) { .cal-stats { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 760px) {
    .cal-tabs { display: flex; }
    .cal-scroll { border: none; background: transparent; overflow: visible; }
    .cal-week { display: block; min-width: 0; }
    .cal-day { display: none; }
    .cal-day[data-active="true"] { display: flex; min-height: 0; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .cal-day-head { background: var(--bg-elev); }
  }

  main { max-width: 1240px; margin: 0 auto; padding: 36px 32px 120px; }

  /* Section head */
  .h-eyebrow { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--fg-subtle); }
  .h-1 { font-size: 28px; font-weight: 600; letter-spacing:-0.02em; line-height: 1.15; margin: 6px 0 0; }
  .h-3 { font-size: 16px; font-weight: 600; line-height: 1.3; margin: 0; }
  .section-head { margin-bottom: 24px; }
  .section-head p { color: var(--fg-muted); font-size: 13px; margin: 8px 0 0; max-width: 60ch; }

  /* Catalog toolbar: filter + sort + tag chips */
  .cat-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
  .cat-filter { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 180px; max-width: 360px;
    height: 36px; padding: 0 10px; background: var(--bg-elev-2); border: 1px solid var(--border);
    border-radius: 9px; color: var(--fg-subtle); transition: border-color .14s, box-shadow .14s; }
  .cat-filter:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); color: var(--accent-soft-fg); }
  .cat-filter input { flex: 1; min-width: 0; height: 100%; background: transparent; border: none; outline: none; color: var(--fg); font: 13px var(--font-sans); }
  .cat-filter input::placeholder { color: var(--fg-subtle); }
  .cat-filter input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
  .cat-sort { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--fg-subtle); white-space: nowrap; }
  .cat-sort select { height: 36px; padding: 0 28px 0 10px; background: var(--bg-elev-2); border: 1px solid var(--border);
    border-radius: 9px; color: var(--fg); font: 13px var(--font-sans); cursor: pointer;
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right 9px center; }
  .cat-sort select:hover { border-color: var(--border-strong); }
  .cat-tags-toggle { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px;
    border-radius: 9px; background: var(--bg-elev-2); border: 1px solid var(--border); color: var(--fg-muted);
    font: 13px var(--font-sans); cursor: pointer; white-space: nowrap; position: relative;
    transition: background .14s, color .14s, border-color .14s; }
  .cat-tags-toggle:hover { color: var(--fg); border-color: var(--border-strong); }
  .cat-tags-toggle[aria-expanded="true"] { color: var(--fg); border-color: var(--border-strong); }
  .cat-tags-toggle svg:last-child { transition: transform .15s; }
  .cat-tags-toggle[aria-expanded="true"] svg:last-child { transform: rotate(180deg); }
  .cat-tags-toggle[data-filtered="true"]::after { content: ""; position: absolute; top: 6px; right: 8px;
    width: 6px; height: 6px; border-radius: 999px; background: var(--accent); }
  .cat-chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; }
  .cat-chips[hidden] { display: none; }
  .chip { height: 28px; padding: 0 12px; border-radius: 999px; background: var(--bg-elev-2);
    border: 1px solid var(--border); color: var(--fg-muted); font: 12px var(--font-sans); cursor: pointer;
    transition: background .14s, color .14s, border-color .14s; white-space: nowrap; }
  .chip:hover { color: var(--fg); border-color: var(--border-strong); }
  .chip[data-active="true"] { background: var(--accent-soft); color: var(--accent-soft-fg); border-color: transparent; }

  /* Poster grid */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 14px; }
  .poster-card {
    position: relative; display: block; border-radius: 10px; overflow: hidden;
    background: var(--bg-elev-2); border: 1px solid var(--border);
    aspect-ratio: 2 / 3; cursor: pointer;
    transition: transform .18s ease, border-color .18s ease;
  }
  .poster-card:hover { border-color: var(--border-strong); transform: translateY(-2px); }
  .poster-card img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  .poster-card .poster-fallback {
    position: absolute; inset: 0; display: grid; place-items: center; padding: 14px;
    background: linear-gradient(135deg, oklch(0.26 0.06 310) 0%, oklch(0.16 0.03 285) 100%);
    font-family: var(--font-mono); font-size: 12px; color: oklch(1 0 0 / 55%); text-align: center;
  }
  .poster-card .poster-overlay {
    position: absolute; inset: auto 0 0 0; padding: 30px 9px 9px;
    background: linear-gradient(to top, oklch(0.1 0 0 / 92%) 20%, oklch(0.1 0 0 / 0%));
  }
  .poster-card .poster-title { font-size: 12px; font-weight: 600; line-height: 1.25; text-wrap: balance;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .poster-card .poster-meta { margin-top: 4px; font-size: 10px; color: var(--fg-muted); display: flex; align-items: center; gap: 5px; }
  .poster-card .type-tag {
    position: absolute; top: 7px; left: 7px;
    display: inline-flex; align-items: center; gap: 4px;
    height: 20px; padding: 0 7px; border-radius: 999px;
    font-size: 9px; font-weight: 500; letter-spacing: 0.02em;
    background: oklch(0.1 0 0 / 65%); color: var(--fg);
    backdrop-filter: blur(6px); border: 1px solid oklch(1 0 0 / 10%);
  }

  /* Badges + dots */
  .badge { display:inline-flex; align-items:center; gap:4px; height:20px; padding:0 8px; border-radius:999px;
    font-size:11px; font-weight:500; background: var(--bg-elev-2); color: var(--fg-muted); border:1px solid var(--border); }
  .badge-mono { font-family: var(--font-mono); }
  .badge-square { border-radius:4px; height:18px; padding:0 5px; font-size:10px; text-transform:uppercase; }
  .badge-accent { background: var(--accent-soft); color: var(--accent-soft-fg); border-color: transparent; }
  .dot { display:inline-block; width:6px; height:6px; border-radius:999px; background: var(--fg-subtle); flex-shrink:0; }
  .dot-airing { background: var(--success); box-shadow: 0 0 0 3px oklch(0.78 0.17 160 / 18%); }
  .dot-info   { background: var(--info);    box-shadow: 0 0 0 3px oklch(0.75 0.14 240 / 18%); }

  .panel { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 12px; }

  /* Series hero */
  .hero { position: relative; height: 300px; margin: -36px -32px 0; overflow: hidden; }
  .hero .backdrop { position:absolute; inset:0; background-size: cover; background-position: center 25%; filter: saturate(1.25) brightness(0.9); transform: scale(1.06); }
  .hero .scrim { position:absolute; inset:0; background:
    repeating-linear-gradient(135deg, transparent 0 18px, oklch(1 0 0 / 2.5%) 18px 19px),
    linear-gradient(to bottom, oklch(0.145 0.008 285 / 35%) 0%, var(--bg) 96%); }
  .series-head { display:grid; grid-template-columns: 200px 1fr; gap: 28px; align-items: end; margin: -150px 0 28px; position: relative; }
  .series-poster { position:relative; aspect-ratio:2/3; border-radius:12px; overflow:hidden;
    border:1px solid var(--border-strong); box-shadow: 0 20px 50px -20px oklch(0 0 0 / 70%); background: var(--bg-elev-2); }
  .series-poster img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; }
  .series-meta-row { display:flex; align-items:center; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
  .series-sub { font-family: var(--font-mono); font-size: 12px; color: var(--fg-subtle); letter-spacing: 0.04em; margin-top: 6px; }

  .series-body { display:grid; grid-template-columns: 1fr 320px; gap: 32px; margin-top: 8px; }
  .ep-head { display:flex; align-items:center; gap:10px; margin-bottom: 14px; }
  .ep-head .spacer { flex: 1; }

  /* Episode rows */
  .eplist { display: flex; flex-direction: column; }
  .eprow { display:flex; gap:14px; align-items:center; padding: 13px 16px; border-bottom: 1px solid var(--border);
    transition: background .14s; }
  .eprow:last-child { border-bottom: none; }
  .eprow:hover { background: oklch(1 0 0 / 3%); }
  .eprow .num { font-family: var(--font-mono); color: var(--fg-subtle); width: 56px; flex:none; font-size: 13px; }
  .eprow .et { color: var(--fg); font-size: 14px; font-weight: 500; flex: 1; min-width: 0; }
  .eprow .go { width:30px; height:30px; border-radius:7px; display:grid; place-items:center; color: var(--fg-subtle);
    background: transparent; transition: background .14s, color .14s; flex:none; }
  .eprow:hover .go { background: var(--accent-soft); color: var(--accent-soft-fg); }

  .synopsis { font-size: 13px; line-height: 1.65; color: var(--fg-muted); margin: 10px 0 0; }

  .empty { color: var(--fg-subtle); padding: 60px 0; text-align: center; }

  /* Tight headers: drop the wordmark + kbd hint, hand the room to the search bar */
  @media (max-width: 560px) {
    .chrome { grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; padding: 0 14px; }
    .chrome .brand .label { display: none; }
    .searchbar .search-kbd { display: none; }
  }
  @media (max-width: 760px) {
    main { padding: 28px 18px 100px; }
    .hero { margin: -28px -18px 0; height: 220px; }
    .series-head { grid-template-columns: 130px 1fr; gap: 18px; margin-top: -110px; }
    .series-body { grid-template-columns: 1fr; gap: 20px; }
  }
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${STYLE}</style></head><body>${body}
<script>
  // "/" focuses the search bar from anywhere (ignored while typing in a field)
  document.addEventListener('keydown', function (e) {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    var el = document.activeElement, tag = el && el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
    var input = document.querySelector('.search-input');
    if (input) { e.preventDefault(); input.focus(); input.select(); }
  });
</script>
</body></html>`;
}

function header(crumb) {
  // Catalog snapshot for the in-page palette (from the loaded Public scope).
  const catalog = collectionItems.map((it) => ({
    id: it.Id,
    name: it.Name || '',
    type: it.Type,
    year: it.ProductionYear || null,
    genres: (it.Genres || []).slice(0, 3),
  }));
  const catalogJson = JSON.stringify(catalog).replace(/</g, '\\u003c');

  return `<header class="chrome">
    <a class="brand" href="/"><span class="brand-mark">B</span><span class="label">boopurnoes <span class="sub">· watch</span></span></a>
    <form class="searchbar" action="/" method="get" role="search" autocomplete="off">
      <span class="search-icon">${svg('search', 16)}</span>
      <input class="search-input" type="search" name="q" placeholder="Search the library…" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Search the library" role="combobox" aria-expanded="false" aria-controls="search-results">
      <span class="search-kbd"><span class="kbd">/</span></span>
      <div class="search-results" id="search-results" role="listbox" style="display:none"></div>
    </form>
    <div class="chrome-right">${crumb || ''}</div>
  </header>
  <script>
    window.__WATCH_CATALOG__ = ${catalogJson};
    (function () {
      var data = window.__WATCH_CATALOG__ || [];
      var ICON_TV = ${JSON.stringify(svg('tv', 14))};
      var ICON_PLAY = ${JSON.stringify(svg('play', 13, 'currentColor'))};
      var bar = document.querySelector('.searchbar');
      var input = document.querySelector('.search-input');
      var box = document.getElementById('search-results');
      if (!bar || !input || !box) return;
      var rows = [], active = -1;

      function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]; }); }
      function initials(n) { return (String(n).match(/[A-Za-z0-9]+/g) || []).slice(0, 2).map(function (s) { return s[0]; }).join('').toUpperCase(); }
      function hrefFor(it) { return it.type === 'Series' ? '/series/' + it.id : '/movie/' + it.id; }

      function score(name, q) {
        name = name.toLowerCase();
        if (name === q) return 1000;
        if (name.indexOf(q) === 0) return 850 - name.length;
        var words = name.split(/[^a-z0-9]+/);
        for (var i = 0; i < words.length; i++) { if (words[i] && words[i].indexOf(q) === 0) return 700 - i; }
        var at = name.indexOf(q);
        if (at > 0) return 500 - at;
        var qi = 0; for (var j = 0; j < name.length && qi < q.length; j++) { if (name[j] === q[qi]) qi++; }
        return qi === q.length ? 150 - name.length : 0;
      }

      function highlight() {
        rows.forEach(function (r, i) { r.setAttribute('data-active', String(i === active)); });
        if (rows[active]) rows[active].scrollIntoView({ block: 'nearest' });
      }

      function close() { box.style.display = 'none'; box.innerHTML = ''; rows = []; active = -1; input.setAttribute('aria-expanded', 'false'); }

      function render(list, q) {
        if (!q) return close();
        if (!list.length) {
          box.innerHTML = '<div class="sr-empty">No matches for \\u201c' + esc(q) + '\\u201d</div>';
          box.style.display = ''; rows = []; active = -1; input.setAttribute('aria-expanded', 'true'); return;
        }
        box.innerHTML = list.map(function (it) {
          var bits = [it.type === 'Series' ? 'Series' : 'Movie'];
          if (it.genres && it.genres.length) bits.push(it.genres.slice(0, 2).join(' · '));
          if (it.year) bits.push(it.year);
          return '<a class="sr-row" role="option" href="' + hrefFor(it) + '">' +
            '<div class="sr-thumb"><span>' + esc(initials(it.name)) + '</span>' +
            '<img src="/img/' + it.id + '" alt="" loading="lazy" onerror="this.remove()"></div>' +
            '<div class="sr-main"><div class="sr-title">' + esc(it.name) + '</div>' +
            '<div class="sr-meta font-mono">' + esc(bits.join('  ·  ')) + '</div></div>' +
            '<span class="sr-go">' + (it.type === 'Series' ? ICON_TV : ICON_PLAY) + '</span></a>';
        }).join('');
        box.style.display = ''; input.setAttribute('aria-expanded', 'true');
        rows = Array.prototype.slice.call(box.querySelectorAll('.sr-row'));
        active = 0; highlight();
      }

      function update() {
        var q = input.value.trim().toLowerCase();
        if (!q) return close();
        var ranked = data.map(function (it) { return { it: it, s: score(it.name, q) }; })
          .filter(function (x) { return x.s > 0; })
          .sort(function (a, b) { return b.s - a.s || a.it.name.localeCompare(b.it.name); })
          .slice(0, 8).map(function (x) { return x.it; });
        render(ranked, q);
      }

      input.addEventListener('input', update);
      input.addEventListener('focus', update);
      input.addEventListener('keydown', function (e) {
        if (box.style.display === 'none') return;
        if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, rows.length - 1); highlight(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
        else if (e.key === 'Enter') { if (rows[active]) { e.preventDefault(); window.location.href = rows[active].getAttribute('href'); } }
        else if (e.key === 'Escape') { close(); input.blur(); }
      });
      input.form.addEventListener('submit', function (e) { e.preventDefault(); if (rows[active]) window.location.href = rows[active].getAttribute('href'); });
      document.addEventListener('click', function (e) { if (!bar.contains(e.target)) close(); });
    })();
  </script>`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.static('public'));

app.get('/health', (req, res) => res.type('text').send('ok'));

// Browse: the Public collection
app.get('/', async (req, res) => {
  try {
    await ensureScope();
  } catch {
    return res.status(502).send(page('watch', header() + '<main><p class="empty">Library unavailable right now.</p></main>'));
  }
  const cards = collectionItems.map((it) => {
    const isSeries = it.Type === 'Series';
    const href = isSeries ? `/series/${it.Id}` : `/movie/${it.Id}`;
    const initials = String(it.Name || '?').split(/[^a-z0-9]/i).filter(Boolean)
      .slice(0, 2).map((s) => s[0]).join('').toUpperCase();
    const metaText = isSeries
      ? `<span class="dot dot-info"></span><span>Series</span>`
      : `<span class="dot dot-airing"></span><span class="font-mono">${esc(it.ProductionYear || 'Film')}</span>`;
    const genres = (it.Genres || []).map((g) => g.toLowerCase()).join('|');
    return `<a class="poster-card" href="${href}" data-title="${esc(String(it.Name || '').toLowerCase())}" data-type="${esc(it.Type)}" data-year="${esc(it.ProductionYear || 0)}" data-genres="${esc(genres)}">
      <div class="poster-fallback">${esc(initials)}</div>
      <img src="/img/${it.Id}" loading="lazy" alt="" onerror="this.remove()">
      <span class="type-tag">${svg(isSeries ? 'tv' : 'film', 11)}${isSeries ? 'Series' : 'Movie'}</span>
      <div class="poster-overlay">
        <div class="poster-title">${esc(it.Name)}</div>
        <div class="poster-meta">${metaText}</div>
      </div>
    </a>`;
  }).join('');

  const genreList = [...new Set(collectionItems.flatMap((it) => it.Genres || []))].sort();
  const chips = [
    ['', 'All'], ['type:movie', 'Movies'], ['type:series', 'Series'],
    ...genreList.map((g) => [`genre:${g.toLowerCase()}`, g]),
  ].map(([tag, label], i) =>
    `<button class="chip" type="button" data-tag="${esc(tag)}" data-active="${i === 0}">${esc(label)}</button>`).join('');

  const toolbar = `<div class="cat-bar">
      <div class="cat-filter">${svg('search', 15)}<input id="cat-q" type="search" placeholder="Filter titles…" autocomplete="off" aria-label="Filter titles"></div>
      <button class="cat-tags-toggle" id="cat-tags-toggle" type="button" aria-expanded="false" aria-controls="cat-chips">${svg('tag', 14)}<span>Tags</span>${svg('chevron', 14)}</button>
      <label class="cat-sort">Sort
        <select id="cat-sort">
          <option value="name">Name</option>
          <option value="year">Year</option>
          <option value="type">Type</option>
        </select>
      </label>
    </div>
    <div class="cat-chips" id="cat-chips" hidden>${chips}</div>`;

  const head = `<div class="section-head">
      <div class="h-eyebrow">Public library</div>
      <h1 class="h-1">Watch</h1>
    </div>`;

  const catScript = `<script>
    (function () {
      var grid = document.getElementById('grid');
      if (!grid) return;
      var cards = [].slice.call(grid.querySelectorAll('.poster-card'));
      var q = document.getElementById('cat-q');
      var sortSel = document.getElementById('cat-sort');
      var chipsBox = document.getElementById('cat-chips');
      var chips = [].slice.call(document.querySelectorAll('#cat-chips .chip'));
      var toggle = document.getElementById('cat-tags-toggle');
      var empty = document.getElementById('cat-empty');
      var tag = '';
      if (toggle && chipsBox) {
        toggle.addEventListener('click', function () {
          var open = chipsBox.hidden;
          chipsBox.hidden = !open;
          toggle.setAttribute('aria-expanded', String(open));
        });
      }
      function ok(c) {
        var v = (q.value || '').trim().toLowerCase();
        if (v && c.getAttribute('data-title').indexOf(v) < 0) return false;
        if (!tag) return true;
        if (tag.indexOf('type:') === 0) return c.getAttribute('data-type').toLowerCase() === tag.slice(5);
        if (tag.indexOf('genre:') === 0) return ('|' + c.getAttribute('data-genres') + '|').indexOf('|' + tag.slice(6) + '|') >= 0;
        return true;
      }
      function apply() {
        var key = sortSel.value;
        var vis = cards.filter(ok);
        vis.sort(function (a, b) {
          if (key === 'year') return (+b.getAttribute('data-year')) - (+a.getAttribute('data-year')) || a.getAttribute('data-title').localeCompare(b.getAttribute('data-title'));
          if (key === 'type') return a.getAttribute('data-type').localeCompare(b.getAttribute('data-type')) || a.getAttribute('data-title').localeCompare(b.getAttribute('data-title'));
          return a.getAttribute('data-title').localeCompare(b.getAttribute('data-title'));
        });
        vis.forEach(function (c) { c.style.display = ''; grid.appendChild(c); });
        cards.filter(function (c) { return vis.indexOf(c) < 0; }).forEach(function (c) { c.style.display = 'none'; });
        if (empty) empty.style.display = vis.length ? 'none' : '';
      }
      q.addEventListener('input', apply);
      sortSel.addEventListener('change', apply);
      chips.forEach(function (ch) {
        ch.addEventListener('click', function () {
          tag = ch.getAttribute('data-tag');
          chips.forEach(function (x) { x.setAttribute('data-active', String(x === ch)); });
          if (toggle) toggle.setAttribute('data-filtered', String(tag !== ''));
          apply();
        });
      });
      apply();
    })();
  </script>`;

  const content = collectionItems.length
    ? `${toolbar}<div class="grid" id="grid">${cards}</div>
       <p class="empty" id="cat-empty" style="display:none">No titles match your filter.</p>${catScript}`
    : '<p class="empty">Nothing here yet. Add titles to the “Public” collection in Jellyfin.</p>';

  const body = header(scheduleNav) + `<main>${head}${content}</main>`;
  res.send(page('watch', body));
});

// Series -> episode list
// Shared detail-page shell (hero + poster + metadata + synopsis sidebar).
// Used by both the series and movie detail pages so they read identically.
function detailShell({ id, name, badges, sub, overview, mainHtml }) {
  const initials = String(name || '?').split(/[^a-z0-9]/i).filter(Boolean)
    .slice(0, 2).map((s) => s[0]).join('').toUpperCase();
  const synopsis = overview
    ? `<div class="panel" style="padding:18px;">
         <div class="h-eyebrow">Synopsis</div>
         <p class="synopsis">${esc(overview)}</p>
       </div>`
    : '';
  return `<main>
    <div class="hero">
      <div class="backdrop" style="background-image:url('/img/${id}')"></div>
      <div class="scrim"></div>
    </div>
    <div class="series-head">
      <div class="series-poster"><div class="poster-fallback" style="position:absolute;inset:0;display:grid;place-items:center;font-family:var(--font-mono);color:oklch(1 0 0 / 55%);">${esc(initials)}</div><img src="/img/${id}" alt="" onerror="this.remove()"></div>
      <div style="padding-bottom:6px;">
        <div class="series-meta-row">${badges}</div>
        <h1 class="h-1" style="font-size:32px;">${esc(name)}</h1>
        ${sub ? `<div class="series-sub">${esc(sub)}</div>` : ''}
      </div>
    </div>
    <div class="series-body">
      <div>${mainHtml}</div>
      <aside>${synopsis}</aside>
    </div>
  </main>`;
}

const detailCrumb = `<a class="crumb" href="/">${svg('back', 15)} All titles</a>`;
const homeCrumb = detailCrumb;
const scheduleNav = `<a class="crumb" href="/schedule">${svg('calendar', 15)} Schedule</a>`;

// Series detail — episode list
app.get('/series/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await ensureScope();
  } catch {
    return res.status(502).send('unavailable');
  }
  if (!isCollectionItem(id)) return res.status(403).send('not available');

  let series, eps;
  try {
    series = await jfItem(id, 'Overview,Genres,ProductionYear');
    eps = await jfJson(`/Shows/${id}/Episodes`, { Fields: 'Overview' });
  } catch {
    return res.status(502).send('unavailable');
  }
  const epItems = eps.Items || [];
  const rows = epItems.map((ep) => {
    const num = (ep.ParentIndexNumber != null && ep.IndexNumber != null)
      ? `S${ep.ParentIndexNumber}·E${ep.IndexNumber}`
      : (ep.IndexNumber != null ? `E${ep.IndexNumber}` : '·');
    return `<a class="eprow" href="/watch/${ep.Id}">
      <span class="num">${esc(num)}</span>
      <span class="et">${esc(ep.Name || 'Episode')}</span>
      <span class="go">${svg('play', 13, 'currentColor')}</span>
    </a>`;
  }).join('');

  const subParts = [];
  if (series.Genres && series.Genres.length) subParts.push(series.Genres.slice(0, 3).join(' · '));
  if (series.ProductionYear) subParts.push(String(series.ProductionYear));

  const badges = `<span class="badge"><span class="dot dot-info"></span>Series</span>
    <span class="badge badge-mono badge-square">${epItems.length} eps</span>`;
  const mainHtml = `
    <div class="ep-head">
      <h2 class="h-3">Episodes</h2>
      <span class="badge badge-mono">${epItems.length}</span>
      <div class="spacer"></div>
    </div>
    <div class="panel" style="overflow:hidden;">
      <div class="eplist">${rows || '<p class="empty">No episodes found.</p>'}</div>
    </div>`;

  const body = header(detailCrumb) + detailShell({
    id, name: series.Name, badges, sub: subParts.join('  ·  '), overview: series.Overview, mainHtml,
  });
  res.send(page(series.Name || 'Series', body));
});

// Movie detail — the movie equivalent of the series page (hero + Play CTA)
app.get('/movie/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await ensureScope();
  } catch {
    return res.status(502).send('unavailable');
  }
  if (!isCollectionItem(id)) return res.status(403).send('not available');

  let item;
  try {
    item = await jfItem(id, 'Overview,Genres,ProductionYear,RunTimeTicks');
  } catch {
    return res.status(502).send('unavailable');
  }
  const mins = item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) : null;

  const subParts = [];
  if (item.Genres && item.Genres.length) subParts.push(item.Genres.slice(0, 3).join(' · '));
  if (item.ProductionYear) subParts.push(String(item.ProductionYear));

  const badges = `<span class="badge"><span class="dot dot-airing"></span>Movie</span>${
    mins ? `<span class="badge badge-mono badge-square">${mins} min</span>` : ''
  }`;
  const mainHtml = `
    <div class="ep-head">
      <h2 class="h-3">Feature film</h2>
      <div class="spacer"></div>
    </div>
    <div class="panel" style="padding:22px; display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
      <a class="btn btn-primary" href="/watch/${id}">${svg('play', 15, 'currentColor')} Play movie</a>
      <span class="font-mono" style="font-size:12px; color:var(--fg-subtle);">${mins ? `${mins} min · ` : ''}HLS stream</span>
    </div>`;

  const body = header(detailCrumb) + detailShell({
    id, name: item.Name, badges, sub: subParts.join('  ·  '), overview: item.Overview, mainHtml,
  });
  res.send(page(item.Name || 'Movie', body));
});

// ---------------------------------------------------------------------------
// Schedule — weekly anime airings, scraped from animeschedule.net's homepage
// (their v3 API needs a token; the homepage server-renders the same data with
//  machine-readable <time datetime> + stable class names).
// ---------------------------------------------------------------------------
const SCHEDULE_TZ = process.env.SCHEDULE_TZ || process.env.TZ || 'America/New_York';
const SCHEDULE_TTL_MS = 30 * 60 * 1000;
const scheduleCache = new Map();   // weekParam ('' = current) -> { result, at, loading }

const decodeEntities = (s) => String(s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Title normalization for matching airings against the library.
const normTitle = (s) => String(s).toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip diacritics
  .replace(/[^a-z0-9]+/g, ' ').trim();
// Drop trailing season/part markers so "Frieren Season 2" matches "Frieren".
const baseTitle = (s) => normTitle(s)
  .replace(/\b(season|cour|part|s)\s*\d+\b/g, ' ')
  .replace(/\b\d+(st|nd|rd|th)?\s+(season|cour|part)\b/g, ' ')
  .replace(/\b(i{1,3}|iv|v|vi{1,3}|ix|x)$/, ' ')        // trailing roman numeral
  .replace(/\s+\d+$/, ' ')                              // trailing number
  .replace(/\s+/g, ' ').trim();

// Generic words that don't identify a show (so they can't bridge two titles).
const TITLE_STOP = new Set(('the and of to in on at as is or no na ni wa ga de da wo desu ka mo ' +
  'season cour part story life world another isekai again after final movie special ova ' +
  'time your hero saga arc days kara shitara datta').split(/\s+/));
// Distinctive tokens of a title: 4+ chars, not a generic word.
const sigTokens = (s) => baseTitle(s).split(' ').filter((w) => w.length >= 4 && !TITLE_STOP.has(w));

// Manual romaji aliases. Some library shows store an English name (TheTVDB) and a
// *kanji* OriginalTitle, which yields no Latin tokens — so they can't bridge to
// animeschedule's romaji title. Map English base-title -> romaji, to seed extra
// signature tokens. Add an entry when a known airing show won't match.
const TITLE_ALIASES = [
  ['classroom of the elite', 'youkoso jitsuryoku shijou shugi no kyoushitsu e'],
];

// Build a matcher that keeps only airings whose show is in the library.
// animeschedule uses romaji; the library often stores English (TheTVDB), so a
// strict match misses. Fall back to a shared distinctive token (e.g. "slime",
// "zero"), restricted to library *series* to avoid movie false positives.
function libraryMatcher(items) {
  const exact = new Set();
  const seriesSig = [];
  for (const it of items) {
    for (const name of [it.Name, it.OriginalTitle].filter(Boolean)) {
      exact.add(normTitle(name));
      const b = baseTitle(name);
      if (b) exact.add(b);
    }
    if (it.Type === 'Series') {
      const names = [it.Name, it.OriginalTitle].filter(Boolean);
      const sig = new Set(names.flatMap(sigTokens));
      const bases = names.map(baseTitle);
      for (const [en, romaji] of TITLE_ALIASES) {
        if (bases.includes(en)) for (const t of sigTokens(romaji)) sig.add(t);
      }
      if (sig.size) seriesSig.push(sig);
    }
  }
  return (title) => {
    const n = normTitle(title);
    const b = baseTitle(title);
    if (exact.has(n) || exact.has(b)) return true;
    const ts = sigTokens(title);
    return ts.length > 0 && seriesSig.some((set) => ts.some((t) => set.has(t)));
  };
}

// Collapse to one entry per show: its most recent episode, and for that episode
// prefer SUB > RAW > DUB so a single clean row shows when to watch the newest ep.
const TYPE_RANK = { sub: 0, raw: 1, dub: 2 };
function latestPerShow(items) {
  const byShow = new Map();
  for (const it of items) {
    const key = normTitle(it.title);
    const cand = { ...it, epNum: parseInt(String(it.ep).replace(/[^0-9]/g, ''), 10) };
    const cur = byShow.get(key);
    if (!cur) { byShow.set(key, cand); continue; }
    const a = cand.epNum, b = cur.epNum;
    let win;
    if (!isNaN(a) && !isNaN(b) && a !== b) win = a > b;              // newer episode wins
    else {
      const rc = TYPE_RANK[cand.type] ?? 9, rk = TYPE_RANK[cur.type] ?? 9;
      win = rc !== rk ? rc < rk : cand.when < cur.when;             // else best type, then earliest
    }
    if (win) byShow.set(key, cand);
  }
  return [...byShow.values()];
}

// Parse a week page -> { airings, prev, next }.
function parseTimetable(html) {
  const body = html.slice(html.indexOf('</head>'));

  // Week navigation: the page links to the prev/next week as ?year=Y&week=W.
  const nav = [...new Set((html.match(/\?year=\d+&week=\d+/g) || []))]
    .map((q) => { const m = q.match(/year=(\d+)&week=(\d+)/); return { year: +m[1], week: +m[2] }; })
    .sort((a, b) => (a.year - b.year) || (a.week - b.week));
  const prev = nav[0] || null;
  const next = nav[nav.length - 1] || null;

  // Airings: title -> episode -> air time -> airType (raw=native/JPN, sub, dub).
  const re = /<h2 class="show-title-bar[^"]*">([^<]+)<\/h2>[\s\S]{0,500}?<span class="show-episode">([^<]*)<\/span>[\s\S]{0,400}?<time datetime="([^"]+)"[\s\S]{0,500}?airType="([^"]+)"/g;
  const airings = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(body))) {
    const title = decodeEntities(m[1]).trim();
    const ep = decodeEntities(m[2]).trim();
    const iso = decodeEntities(m[3]).trim();
    const when = new Date(iso);
    if (isNaN(when)) continue;
    const localDate = iso.slice(0, 10);   // site-local date — lines up with the columns
    const at = decodeEntities(m[4]).toLowerCase();
    const type = at.includes('sub') ? 'sub' : at.includes('dub') ? 'dub' : 'raw';
    const key = `${normTitle(title)}|${ep}|${iso}|${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pre = body.slice(Math.max(0, m.index - 2600), m.index);
    const imgs = pre.match(/https:\/\/img\.animeschedule\.net\/[^\s"']+?\.jpg/g);
    let img = imgs ? imgs[imgs.length - 1] : null;
    if (img) img = img.replace(/&amp;/g, '&') + '?w=120&q=85';
    airings.push({ title, ep, when, localDate, img, type });
  }
  return { airings, prev, next };
}

// Fetch + cache one week. weekParam '' = current week; else 'year=Y&week=W'.
async function getSchedule(weekParam) {
  const k = weekParam || 'current';
  const hit = scheduleCache.get(k);
  if (hit && hit.result && Date.now() - hit.at < SCHEDULE_TTL_MS) return hit.result;
  if (hit && hit.loading) return hit.loading;
  const url = 'https://animeschedule.net/' + (weekParam ? `?${weekParam}` : '');
  const loading = fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' } })
    .then(async (res) => {
      if (!res.ok) throw new Error(`animeschedule -> ${res.status}`);
      const result = parseTimetable(await res.text());
      scheduleCache.set(k, { result, at: Date.now(), loading: null });
      return result;
    })
    .catch((e) => { scheduleCache.set(k, { result: hit && hit.result, at: 0, loading: null }); throw e; });
  scheduleCache.set(k, { result: hit && hit.result, at: hit ? hit.at : 0, loading });
  return loading;
}

// tz-aware formatters (one absolute instant -> parts in SCHEDULE_TZ)
const fmtKey = new Intl.DateTimeFormat('en-CA', { timeZone: SCHEDULE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtDow = new Intl.DateTimeFormat('en-US', { timeZone: SCHEDULE_TZ, weekday: 'short' });
const fmtMd = new Intl.DateTimeFormat('en-US', { timeZone: SCHEDULE_TZ, month: 'short', day: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: SCHEDULE_TZ, hour: '2-digit', minute: '2-digit' });
const dayKey = (d) => fmtKey.format(d);

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Build the Mon..Sun window for the fetched week, derived from the airings'
// own site-local dates (the homepage reorders/special-cases today, so we don't
// trust its column markup). `allAirings` anchors the week; `items` get bucketed.
function buildDays(items, allAirings, now) {
  if (!allAirings.length) return [];
  // median date → robust to stray entries near week edges
  const sorted = allAirings.map((a) => a.localDate).sort();
  const [y, mo, d] = sorted[Math.floor(sorted.length / 2)].split('-').map(Number);
  const ref = new Date(Date.UTC(y, mo - 1, d));
  const mondayMs = ref.getTime() - ((ref.getUTCDay() + 6) % 7) * 86400000;
  const todayKey = fmtKey.format(now);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(mondayMs + i * 86400000);
    const iso = dt.toISOString().slice(0, 10);
    days.push({
      iso, dow: DOW_SHORT[dt.getUTCDay()],
      label: `${dt.getUTCDate()} ${MON_SHORT[dt.getUTCMonth()]}`,
      today: iso === todayKey, events: [],
    });
  }
  const byIso = Object.fromEntries(days.map((dd) => [dd.iso, dd]));
  for (const a of items) { const b = byIso[a.localDate]; if (b) b.events.push(a); }
  let next = null;
  for (const dd of days) {
    dd.events.sort((a, b) => a.when - b.when);
    for (const e of dd.events) {
      e.aired = e.when < now;
      if (!e.aired && (!next || e.when < next.when)) next = e;
    }
  }
  if (next) next.now = true;
  return days;
}

// Schedule page
app.get('/schedule', async (req, res) => {
  const weekParam = (/^\d{4}$/.test(req.query.year) && /^\d{1,2}$/.test(req.query.week))
    ? `year=${req.query.year}&week=${req.query.week}` : '';
  let sched;
  try {
    [sched] = await Promise.all([getSchedule(weekParam), ensureScope()]);
  } catch {
    return res.status(502).send(page('schedule', header(homeCrumb) +
      '<main><p class="empty">Schedule unavailable right now.</p></main>'));
  }
  // Keep airings whose show is in the Public library, then one row per show
  // (its most recent episode, shown once).
  const inLibrary = libraryMatcher(collectionItems);
  const items = latestPerShow(sched.airings.filter((it) => inLibrary(it.title)));

  const now = new Date();
  const days = buildDays(items, sched.airings, now);

  const total = days.reduce((n, d) => n + d.events.length, 0);
  const today = days.find((d) => d.today);
  const aired = days.reduce((n, d) => n + d.events.filter((e) => e.aired).length, 0);
  const upcoming = total - aired;
  const range = days.length ? `${days[0].label} — ${days[days.length - 1].label}` : '';
  const isCurrent = weekParam === '';
  const prevHref = sched.prev ? `/schedule?year=${sched.prev.year}&week=${sched.prev.week}` : '';
  const nextHref = sched.next ? `/schedule?year=${sched.next.year}&week=${sched.next.week}` : '';
  // On other weeks there's no "today" — default the mobile view to the first day
  // that has episodes (else the first day).
  let activeIdx = days.findIndex((d) => d.today);
  if (activeIdx < 0) activeIdx = days.findIndex((d) => d.events.length);
  if (activeIdx < 0) activeIdx = 0;

  const LANG = { sub: 'SUB', dub: 'DUB', raw: 'RAW' };
  const eventCard = (e) => `
    <div class="evt${e.now ? ' now' : ''}${e.aired ? ' aired' : ''}">
      <div class="evt-main">
        <div class="evt-thumb">${e.img ? `<img src="${esc(e.img)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
        <div class="evt-body">
          <div class="evt-title">${esc(e.title)}</div>
          <div class="evt-meta">
            <span class="evt-time">${esc(fmtTime.format(e.when))}</span>
            ${e.ep ? `<span class="badge badge-mono badge-square">${esc(e.ep)}</span>` : ''}
            <span class="lang lang-${e.type}">${LANG[e.type] || 'RAW'}</span>
          </div>
          <div class="evt-meta">
            <span class="evt-label${e.aired ? '' : ' up'}">${e.aired ? 'Aired' : 'Upcoming'}</span>
            ${e.now ? '<span class="badge badge-accent badge-square">Next</span>' : ''}
          </div>
        </div>
      </div>
    </div>`;

  // Mobile day selector — today (or first populated day on other weeks) active.
  const tabs = days.map((d, i) => `
    <button class="cal-tab${d.today ? ' today' : ''}" data-active="${i === activeIdx}" type="button">
      <span class="d">${esc(d.dow)}</span>
      <span class="n">${esc((d.label.match(/\d+/) || [''])[0])}</span>
      <span class="c">${d.events.length ? `${d.events.length} ep` : '—'}</span>
    </button>`).join('');

  const week = days.map((d, i) => `
    <div class="cal-day${d.today ? ' today' : ''}" data-active="${i === activeIdx}">
      <div class="cal-day-head">
        <div>
          <div class="cal-dow">${esc(d.dow)}</div>
          <div class="cal-date">${esc(d.label)}</div>
        </div>
        ${d.events.length ? `<span class="badge badge-mono">${d.events.length}</span>` : ''}
      </div>
      <div class="cal-events">
        ${d.events.length ? d.events.map(eventCard).join('') : '<div class="cal-empty">No episodes</div>'}
      </div>
    </div>`).join('');

  const head = `<div class="section-head">
      <div class="h-eyebrow">${isCurrent ? 'This week' : 'Week of'} · ${esc(range)}</div>
      <h1 class="h-1">Schedule</h1>
      <p>The latest episode of each title in your library (${esc(SCHEDULE_TZ.replace(/_/g, ' '))}), via animeschedule.net.</p>
    </div>`;
  const nav = `<div class="cal-nav">
      <a class="btn btn-secondary btn-icon${prevHref ? '' : ' disabled'}" href="${prevHref || '#'}" aria-label="Previous week">${svg('back', 16)}</a>
      <a class="btn btn-secondary${isCurrent ? ' disabled' : ''}" href="/schedule">Today</a>
      <a class="btn btn-secondary btn-icon${nextHref ? '' : ' disabled'}" href="${nextHref || '#'}" aria-label="Next week">${svg('fwd', 16)}</a>
      <span class="cal-range">${esc(range)}</span>
    </div>`;
  const stats = `<div class="cal-stats">
      ${[
        ['This week', String(total), 'episodes'],
        ['Today', String(today ? today.events.length : 0), today ? today.label : ''],
        ['Aired', String(aired), 'already out'],
        ['Upcoming', String(upcoming), 'still to air'],
      ].map(([k, v, s]) => `<div class="cal-stat"><div class="h-eyebrow" style="font-size:10px;">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('')}
    </div>`;

  const emptyBanner = total === 0
    ? '<p class="empty">No episodes this week for titles in your library. Add airing series to the “Public” collection to see them here.</p>'
    : '';

  const switcher = `<script>
    (function () {
      var tabs = [].slice.call(document.querySelectorAll('.cal-tab'));
      var days = [].slice.call(document.querySelectorAll('.cal-day'));
      tabs.forEach(function (t, i) {
        t.addEventListener('click', function () {
          tabs.forEach(function (x, j) { x.setAttribute('data-active', String(j === i)); });
          days.forEach(function (d, j) { d.setAttribute('data-active', String(j === i)); });
        });
      });
    })();
  </script>`;

  const body = header(homeCrumb) + `<main>${head}${nav}${stats}
    <div class="cal-tabs">${tabs}</div>
    <div class="cal-scroll"><div class="cal-week">${week}</div></div>
    ${emptyBanner}
  </main>${switcher}`;
  res.send(page('Schedule · watch', body));
});

// Player page
// Human-readable audio/subtitle stream labels.
const LANG_NAMES = {
  eng: 'English', jpn: 'Japanese', jap: 'Japanese', spa: 'Spanish', fre: 'French', fra: 'French',
  ger: 'German', deu: 'German', por: 'Portuguese', ita: 'Italian', kor: 'Korean', chi: 'Chinese',
  zho: 'Chinese', rus: 'Russian', ara: 'Arabic', vie: 'Vietnamese', tha: 'Thai', ind: 'Indonesian',
  und: 'Unknown',
};
const langName = (c) => (c ? (LANG_NAMES[String(c).toLowerCase()] || String(c).toUpperCase()) : 'Unknown');
const chLabel = (n) => (n === 1 ? 'Mono' : n === 2 ? 'Stereo' : n === 6 ? '5.1' : n === 8 ? '7.1' : n ? `${n}ch` : '');

// Server-side quality presets (resolution + bitrate cap). Auto = source-driven.
const QUALITY_PRESETS = [
  { key: 'auto', label: 'Auto', h: 0, vb: 0 },
  { key: '1080', label: '1080p', h: 1080, vb: 8000000 },
  { key: '720', label: '720p', h: 720, vb: 4000000 },
  { key: '480', label: '480p', h: 480, vb: 1500000 },
  { key: '240', label: '240p', h: 240, vb: 600000 },
];

app.get('/watch/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await ensureScope();
  } catch {
    return res.status(502).send('unavailable');
  }
  if (!playableIds.has(id)) return res.status(403).send('not available');

  let item = {};
  try { item = await jfItem(id, 'MediaStreams,MediaSources,Overview'); } catch { /* title is cosmetic */ }
  const title = item.Name || 'Now playing';
  const epNum = (item.ParentIndexNumber != null && item.IndexNumber != null)
    ? `S${item.ParentIndexNumber}·E${item.IndexNumber}` : '';
  const isEpisode = item.Type === 'Episode' && item.SeriesId;
  const backHref = isEpisode ? `/series/${item.SeriesId}` : '/';
  const backLabel = isEpisode ? (item.SeriesName || 'Series') : 'All titles';

  // Audio + subtitle tracks (drive the sub/dub menus).
  const streams = item.MediaStreams
    || (item.MediaSources && item.MediaSources[0] && item.MediaSources[0].MediaStreams) || [];
  const audioTracks = streams.filter((s) => s.Type === 'Audio').map((s) => ({
    index: s.Index,
    lang: String(s.Language || '').toLowerCase(),
    label: langName(s.Language),
    detail: [String(s.Codec || '').toUpperCase(), chLabel(s.Channels)].filter(Boolean).join(' · '),
    def: !!s.IsDefault,
  }));
  const defAudio = (audioTracks.find((t) => t.def) || audioTracks[0] || {}).index;

  // Subtitles: English only, burned in server-side. Condense the long track list
  // to the "Full" dialogue tracks (one per release group, e.g. KawaSubs / FLE),
  // dropping the redundant signs-only / CC / SDH / forced variants.
  const isTextSub = (s) => s.IsTextSubtitleStream
    || /^(ass|ssa|subrip|srt|webvtt|vtt|mov_text|text)$/i.test(s.Codec || '');
  const isEngSub = (s) => /^en/i.test(s.Language || '') || /\beng(lish)?\b/i.test(s.DisplayTitle || s.Title || '');
  const subCat = (s) => {
    const t = `${s.Title || ''} ${s.DisplayTitle || ''}`.toLowerCase();
    if (s.IsForced || /forced/.test(t)) return 'forced';
    if (/sdh|deaf|hard of hearing|closed caption|\bcc\b/.test(t)) return 'cc';
    if (/(sign|song)/.test(t) && !/\bfull\b/.test(t)) return 'signs';
    return 'full';
  };
  // Release-group tag, e.g. "English - Full Subtitles [KawaSubs]" -> "KawaSubs".
  const subGroup = (s) => {
    const m = `${s.Title || ''} ${s.DisplayTitle || ''}`.match(/\[([^\]]+)\]/);
    return m ? m[1].trim() : '';
  };
  const engSubs = streams.filter((s) => s.Type === 'Subtitle' && isTextSub(s) && isEngSub(s));
  let subSources = engSubs.filter((s) => subCat(s) === 'full');
  if (!subSources.length) subSources = engSubs;                     // fallback: whatever English we have
  // Styled ASS/SSA first (carry the signs & songs typesetting), then by index.
  subSources = subSources.sort((a, b) => {
    const ass = (/^(ass|ssa)$/i.test(b.Codec || '') ? 1 : 0) - (/^(ass|ssa)$/i.test(a.Codec || '') ? 1 : 0);
    return ass || a.Index - b.Index;
  }).map((s) => ({ index: s.Index, group: subGroup(s) }));

  // Sibling episodes (for the in-player list + auto-advance), scoped to the public set.
  let episodes = [];
  if (isEpisode) {
    try {
      const e = await jfJson(`/Shows/${item.SeriesId}/Episodes`);
      episodes = (e.Items || []).filter((ep) => playableIds.has(ep.Id));
    } catch { /* sidebar is optional */ }
  }
  const curIdx = episodes.findIndex((ep) => ep.Id === id);
  const nextEp = curIdx >= 0 ? episodes[curIdx + 1] : null;
  const epLabel = (ep) => (ep.ParentIndexNumber != null && ep.IndexNumber != null)
    ? `S${ep.ParentIndexNumber}·E${ep.IndexNumber}` : (ep.IndexNumber != null ? `E${ep.IndexNumber}` : '·');

  // --- menu builders (only render a menu when there's a real choice) ---
  const popitem = (active, attrs, label, detail) =>
    `<button type="button" class="popitem" role="option" data-active="${active}" ${attrs}>
       <span class="pi-main">${esc(label)}</span>${detail ? `<span class="pi-detail">${esc(detail)}</span>` : ''}
     </button>`;

  const defAudioLabel = (audioTracks.find((t) => t.index === defAudio) || {}).label || 'Audio';
  const audioMenu = audioTracks.length > 1 ? `
    <details class="pmenu" data-kind="audio">
      <summary>${svg('audio', 16)}<span class="pmlabel">${esc(defAudioLabel)}</span>${svg('chevron', 14)}</summary>
      <div class="pop" role="listbox">
        <div class="pop-head">Audio</div>
        ${audioTracks.map((t) => popitem(t.index === defAudio, `data-index="${t.index}" data-lang="${esc(t.lang)}" data-short="${esc(t.label)}"`, t.label, t.detail)).join('')}
      </div>
    </details>` : '';

  const subMenu = subSources.length ? `
    <details class="pmenu" data-kind="subs">
      <summary>${svg('captions', 16)}<span class="pmlabel">Subtitles: Off</span>${svg('chevron', 14)}</summary>
      <div class="pop" role="listbox">
        <div class="pop-head">Subtitles</div>
        ${popitem(true, 'data-index="" data-group="" data-short="Off"', 'Off', '')}
        ${subSources.map((s, i) => popitem(false,
          `data-index="${s.index}" data-group="${esc(s.group)}" data-short="${esc(s.group || 'English')}"`,
          'English', s.group || (subSources.length > 1 ? `Track ${i + 1}` : 'Full'))).join('')}
      </div>
    </details>` : '';

  const qualityMenu = `
    <details class="pmenu" data-kind="quality">
      <summary>${svg('gear', 16)}<span class="pmlabel">Auto</span>${svg('chevron', 14)}</summary>
      <div class="pop" role="listbox">
        <div class="pop-head">Quality</div>
        ${QUALITY_PRESETS.map((q) => popitem(q.key === 'auto', `data-key="${q.key}" data-h="${q.h}" data-vb="${q.vb}" data-short="${esc(q.label)}"`, q.label, '')).join('')}
      </div>
    </details>`;

  const nextBtn = nextEp
    ? `<a class="pctl" href="/watch/${nextEp.Id}" title="Next episode">${svg('next', 16)}<span>Next</span></a>`
    : '';

  const epsAside = episodes.length ? `
    <aside class="col-eps panel">
      <div class="eps-head">${svg('tv', 15)}<span>Episodes</span><span class="badge">${episodes.length}</span></div>
      <div class="eps-list" id="eps">
        ${episodes.map((ep) => `<a class="eprow${ep.Id === id ? ' current' : ''}" href="/watch/${ep.Id}"${ep.Id === id ? ' aria-current="true"' : ''}>
          <span class="epn">${esc(epLabel(ep))}</span>
          <span class="ept">${esc(ep.Name || 'Episode')}</span>
          ${ep.Id === id ? `<span class="epnow">${svg('play', 12, 'currentColor')}</span>` : ''}
        </a>`).join('')}
      </div>
    </aside>` : '';

  const clientData = JSON.stringify({
    id,
    audio: defAudio == null ? null : String(defAudio),
    next: nextEp ? nextEp.Id : null,
  }).replace(/</g, '\\u003c');

  res.send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · watch</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark;
    --font-sans:"Geist",ui-sans-serif,system-ui,sans-serif; --font-mono:"Geist Mono",ui-monospace,Menlo,monospace;
    --bg:oklch(0.145 0.008 285); --bg-elev:oklch(0.185 0.01 285); --bg-elev-2:oklch(0.22 0.012 285);
    --bg-hover:oklch(0.25 0.015 285);
    --fg:oklch(0.985 0.003 285); --fg-muted:oklch(0.72 0.012 285); --fg-subtle:oklch(0.55 0.012 285);
    --accent:oklch(0.72 0.18 310); --accent-soft:oklch(0.72 0.18 310 / 12%); --accent-soft-fg:oklch(0.82 0.18 310);
    --border:oklch(1 0 0 / 8%); --border-strong:oklch(1 0 0 / 14%);
  }
  * { box-sizing:border-box; }
  body { margin:0; background:#000; color:var(--fg); font:15px/1.5 var(--font-sans); -webkit-font-smoothing:antialiased; }
  a { text-decoration:none; color:inherit; }
  .icon { flex-shrink:0; }

  .topbar { padding:14px 22px; display:flex; gap:14px; align-items:center; border-bottom:1px solid var(--border);
    background: oklch(0.145 0.008 285 / 70%); backdrop-filter: blur(10px); }
  .topbar .back { display:inline-flex; align-items:center; gap:6px; color:var(--fg-muted); font-size:13px; }
  .topbar .back:hover { color:var(--fg); }
  .topbar .sep { color:var(--fg-subtle); }
  .topbar .t { color:var(--fg); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .topbar .ep { font-family:var(--font-mono); font-size:11px; color:var(--accent-soft-fg); background:var(--accent-soft);
    padding:2px 7px; border-radius:5px; flex:none; }

  .wrap { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:20px;
    max-width:1560px; margin:0 auto; padding:20px; align-items:start; }
  .wrap.no-eps { grid-template-columns:minmax(0,1fr); max-width:1280px; }
  .col-video { min-width:0; }
  .vid { position:relative; background:#000; border-radius:12px; overflow:hidden;
    box-shadow:0 30px 80px -30px oklch(0 0 0 / 80%); }
  video { display:block; width:100%; max-height:78vh; background:#000; }

  /* Player control bar (custom; sits under the native <video controls>) */
  .pbar { display:flex; align-items:center; gap:8px; margin-top:12px; flex-wrap:wrap; }
  .pbar .spacer { flex:1; }
  .pctl, .pmenu > summary {
    display:inline-flex; align-items:center; gap:7px; height:38px; padding:0 13px; border-radius:9px;
    background:var(--bg-elev-2); border:1px solid var(--border); color:var(--fg); font:13px var(--font-sans);
    cursor:pointer; white-space:nowrap; user-select:none; list-style:none;
    transition:background .14s, border-color .14s, color .14s; }
  .pctl:hover, .pmenu > summary:hover { background:var(--bg-hover); border-color:var(--border-strong); }
  .pmenu > summary::-webkit-details-marker { display:none; }
  .pmenu > summary .pmlabel { max-width:140px; overflow:hidden; text-overflow:ellipsis; }
  .pmenu > summary svg:last-child { color:var(--fg-subtle); transition:transform .15s; }
  .pmenu[open] > summary { background:var(--bg-hover); border-color:var(--border-strong); }
  .pmenu[open] > summary svg:last-child { transform:rotate(180deg); }

  .pmenu { position:relative; }
  .pop { position:absolute; bottom:calc(100% + 8px); right:0; min-width:220px; z-index:140;
    background:var(--bg-elev); border:1px solid var(--border); border-radius:11px; padding:6px;
    box-shadow:0 30px 80px -20px oklch(0 0 0 / 75%); max-height:340px; overflow-y:auto; }
  .pop-head { font-family:var(--font-mono); font-size:10px; text-transform:uppercase; letter-spacing:0.1em;
    color:var(--fg-subtle); padding:6px 10px 8px; }
  .popitem { display:flex; align-items:baseline; gap:10px; width:100%; text-align:left; padding:8px 10px;
    border:none; border-radius:7px; background:transparent; color:var(--fg); font:13px var(--font-sans);
    cursor:pointer; }
  .popitem:hover { background:var(--bg-hover); }
  .popitem[data-active="true"] { background:var(--accent-soft); color:var(--accent-soft-fg); }
  .pi-main { flex:1; min-width:0; }
  .pi-detail { font-family:var(--font-mono); font-size:10.5px; color:var(--fg-subtle); white-space:nowrap; }
  .popitem[data-active="true"] .pi-detail { color:var(--accent-soft-fg); opacity:.8; }

  /* Episode sidebar */
  .panel { background:var(--bg-elev); border:1px solid var(--border); border-radius:12px; }
  .col-eps { display:flex; flex-direction:column; max-height:calc(100vh - 92px); position:sticky; top:20px; overflow:hidden; }
  .eps-head { display:flex; align-items:center; gap:8px; padding:14px 16px; border-bottom:1px solid var(--border);
    font-weight:600; font-size:14px; }
  .eps-head .badge { margin-left:auto; font-family:var(--font-mono); font-size:11px; font-weight:500;
    height:20px; padding:0 8px; display:inline-flex; align-items:center; border-radius:999px;
    background:var(--bg-elev-2); color:var(--fg-muted); border:1px solid var(--border); }
  .eps-list { overflow-y:auto; padding:6px; }
  .eprow { display:flex; align-items:center; gap:12px; padding:10px 12px; border-radius:9px; }
  .eprow:hover { background:oklch(1 0 0 / 4%); }
  .eprow .epn { font-family:var(--font-mono); font-size:12px; color:var(--fg-subtle); flex:none; width:54px; }
  .eprow .ept { font-size:13px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .eprow.current { background:var(--accent-soft); }
  .eprow.current .epn { color:var(--accent-soft-fg); }
  .eprow.current .ept { color:var(--accent-soft-fg); font-weight:600; }
  .eprow .epnow { color:var(--accent-soft-fg); display:flex; flex:none; }
  .eprow.watched { opacity:0.45; }
  .eprow.watched:hover { opacity:1; }
  .eprow.watched .epn, .eprow.watched .ept { color:var(--fg-subtle); }

  /* Theater mode: fill the viewport in-page (no real fullscreen) */
  body.theater { overflow:hidden; }
  body.theater .topbar { display:none; }
  body.theater .wrap { display:block; max-width:none; margin:0; padding:0; height:100vh; }
  body.theater .col-eps { display:none; }
  body.theater .col-video { position:fixed; inset:0; z-index:100; background:#000; display:flex; flex-direction:column; }
  body.theater .vid { flex:1; min-height:0; border-radius:0; box-shadow:none; display:flex; }
  body.theater video { max-height:none; height:100%; width:100%; object-fit:contain; }
  body.theater .pbar { margin:0; padding:10px 16px; gap:8px;
    background:oklch(0.145 0.008 285 / 94%); border-top:1px solid var(--border); }

  @media (max-width: 980px) {
    .wrap { grid-template-columns:minmax(0,1fr); }
    .col-eps { position:static; max-height:420px; }
  }
</style></head><body>
<div class="topbar">
  <a class="back" href="${backHref}">${svg('back', 15)} ${esc(backLabel)}</a>
  <span class="sep">/</span>
  ${epNum ? `<span class="ep">${esc(epNum)}</span>` : ''}
  <span class="t">${esc(title)}</span>
</div>
<div class="wrap${episodes.length ? '' : ' no-eps'}">
  <div class="col-video">
    <div class="vid"><video id="v" controls autoplay playsinline></video></div>
    <div class="pbar">
      ${nextBtn}
      <div class="spacer"></div>
      ${audioMenu}${subMenu}${qualityMenu}
      <button type="button" class="pctl" id="theater">${svg('theater', 16)}<span id="theater-label">Theater</span></button>
    </div>
  </div>
  ${epsAside}
</div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<script src="https://cdn.jsdelivr.net/npm/jassub@1.8.8/dist/jassub.umd.js"></script>
<script>
  (function () {
    var D = ${clientData};
    var v = document.getElementById('v');
    var hls = null;
    var state = { audio: D.audio, subs: null, h: 0, vb: 0 };

    // ---- persisted preferences (audio language, subtitles on/off, quality) ----
    var PREF_KEY = 'bw:pref';
    function readPref() { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; } }
    function savePref(patch) { var p = readPref(); for (var k in patch) p[k] = patch[k]; try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) {} }
    var pref = readPref();

    // ---- watched episodes (a set of ids, used to dim rows in the sidebar) ----
    var WATCHED_KEY = 'bw:watched';
    function readWatched() { try { return JSON.parse(localStorage.getItem(WATCHED_KEY)) || {}; } catch (e) { return {}; } }
    function markWatched(id) { var w = readWatched(); if (!w[id]) { w[id] = 1; try { localStorage.setItem(WATCHED_KEY, JSON.stringify(w)); } catch (e) {} } }

    // ---- resume position (per episode) ----
    var POS_KEY = 'bw:pos:' + D.id;
    function savePos() {
      var d = v.duration;
      if (!d || isNaN(d)) return;
      var t = v.currentTime || 0;
      try {
        if (t > 5 && t < d - 15) localStorage.setItem(POS_KEY, String(Math.floor(t)));
        else { localStorage.removeItem(POS_KEY); if (t >= d - 15) markWatched(D.id); }   // finished -> watched
      } catch (e) {}
    }
    var resumeAt = (function () { var n = parseInt(localStorage.getItem(POS_KEY), 10); return Number.isInteger(n) && n > 5 ? n : 0; })();
    setInterval(savePos, 5000);
    window.addEventListener('pagehide', savePos);
    document.addEventListener('visibilitychange', function () { if (document.hidden) savePos(); });

    function buildSrc() {
      var p = new URLSearchParams();
      if (state.audio != null && state.audio !== '') p.set('audio', state.audio);
      if (state.h) p.set('h', state.h);
      if (state.vb) p.set('vb', state.vb);
      var qs = p.toString();
      return '/api/play/' + encodeURIComponent(D.id) + '/master.m3u8' + (qs ? '?' + qs : '');
    }

    // initial=true seeks to the resume point; otherwise we preserve the live position.
    function load(initial) {
      var t = initial ? resumeAt : (v.currentTime || 0);
      var wasPlaying = initial ? true : !v.paused;
      var src = buildSrc();
      function restore() { if (t > 0) { try { v.currentTime = t; } catch (e) {} } if (wasPlaying) { v.play().catch(function () {}); } }
      if (hls) { hls.destroy(); hls = null; }
      if (window.Hls && window.Hls.isSupported()) {
        hls = new Hls({ enableWorker: true });
        hls.loadSource(src);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, restore);
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = src;
        v.addEventListener('loadedmetadata', function h2() { v.removeEventListener('loadedmetadata', h2); restore(); });
      } else {
        document.body.insertAdjacentHTML('beforeend', '<p style="padding:20px">Your browser cannot play HLS.</p>');
      }
    }

    // ---- client-side subtitles (JASSUB) -------------------------------------
    // Subs are an overlay on the same <video>, independent of the transcode, so
    // switching tracks is instant and survives audio/quality reloads (the video
    // element persists). Off -> tear the renderer down.
    var JASSUB_CDN = 'https://cdn.jsdelivr.net/npm/jassub@1.8.8/dist/';
    var subRenderer = null;
    function subUrl(ix) { return '/api/sub/' + encodeURIComponent(D.id) + '/' + encodeURIComponent(ix); }
    function setSub(ix) {
      state.subs = (ix == null || ix === '') ? null : ix;
      if (state.subs == null) {
        if (subRenderer) { subRenderer.destroy(); subRenderer = null; }
        return;
      }
      var url = subUrl(state.subs);
      if (subRenderer) {
        subRenderer.setTrackByUrl(url);
      } else if (window.JASSUB) {
        subRenderer = new JASSUB({
          video: v,
          subUrl: url,
          workerUrl: JASSUB_CDN + 'jassub-worker.js',
          wasmUrl: JASSUB_CDN + 'jassub-worker.wasm',
          legacyWasmUrl: JASSUB_CDN + 'jassub-worker.wasm.js',
        });
      }
    }

    function applyItem(menu, it, kind) {
      menu.querySelectorAll('.popitem').forEach(function (x) { x.setAttribute('data-active', 'false'); });
      it.setAttribute('data-active', 'true');
      var label = menu.querySelector('.pmlabel');
      if (label) { var s = it.getAttribute('data-short') || ''; label.textContent = kind === 'subs' ? 'Subtitles: ' + s : s; }
    }

    document.querySelectorAll('.pmenu').forEach(function (menu) {
      var kind = menu.getAttribute('data-kind');
      menu.querySelectorAll('.popitem').forEach(function (it) {
        it.addEventListener('click', function () {
          applyItem(menu, it, kind);
          menu.open = false;
          if (kind === 'audio') {
            state.audio = it.getAttribute('data-index');
            savePref({ audioLang: it.getAttribute('data-lang') || '' });
            load(false);                       // audio is muxed into the transcode -> reload
          } else if (kind === 'quality') {
            state.h = +(it.getAttribute('data-h') || 0); state.vb = +(it.getAttribute('data-vb') || 0);
            savePref({ quality: it.getAttribute('data-key') || 'auto' });
            load(false);
          } else if (kind === 'subs') {
            var ix = it.getAttribute('data-index');
            savePref({ subGroup: ix === '' ? 'off' : (it.getAttribute('data-group') || 'on') });
            setSub(ix === '' ? null : ix);     // client-side overlay -> no reload
          }
        });
      });
    });

    // Close any open menu when clicking elsewhere.
    document.addEventListener('click', function (e) {
      document.querySelectorAll('.pmenu[open]').forEach(function (m) { if (!m.contains(e.target)) m.open = false; });
    });

    // ---- restore saved preferences into the menus before first load ----
    var aMenu = document.querySelector('.pmenu[data-kind="audio"]');
    if (aMenu && pref.audioLang) {
      var ai = aMenu.querySelector('.popitem[data-lang="' + (window.CSS && CSS.escape ? CSS.escape(pref.audioLang) : pref.audioLang) + '"]');
      if (ai) { applyItem(aMenu, ai, 'audio'); state.audio = ai.getAttribute('data-index'); }
    }
    var qMenu = document.querySelector('.pmenu[data-kind="quality"]');
    if (qMenu && pref.quality && pref.quality !== 'auto') {
      var qi = qMenu.querySelector('.popitem[data-key="' + pref.quality + '"]');
      if (qi) { applyItem(qMenu, qi, 'quality'); state.h = +(qi.getAttribute('data-h') || 0); state.vb = +(qi.getAttribute('data-vb') || 0); }
    }
    var sMenu = document.querySelector('.pmenu[data-kind="subs"]');
    if (sMenu && pref.subGroup && pref.subGroup !== 'off') {
      // Re-select the same release group when available, else the first English track.
      var si = sMenu.querySelector('.popitem[data-group="' + (window.CSS && CSS.escape ? CSS.escape(pref.subGroup) : pref.subGroup) + '"]')
        || sMenu.querySelector('.popitem[data-index]:not([data-index=""])');
      if (si && si.getAttribute('data-index')) { applyItem(sMenu, si, 'subs'); state.subs = si.getAttribute('data-index'); }
    }

    // Theater mode (in-page, not the browser fullscreen API).
    var theaterBtn = document.getElementById('theater');
    var ICON_THEATER = ${JSON.stringify(svg('theater', 16))};
    var ICON_SHRINK = ${JSON.stringify(svg('shrink', 16))};
    function setTheater(on) {
      document.body.classList.toggle('theater', on);
      theaterBtn.innerHTML = (on ? ICON_SHRINK : ICON_THEATER)
        + '<span id="theater-label">' + (on ? 'Exit theater' : 'Theater') + '</span>';
    }
    theaterBtn.addEventListener('click', function () { setTheater(!document.body.classList.contains('theater')); });

    // Keyboard: 't' toggles theater, Esc exits it (ignored while typing).
    document.addEventListener('keydown', function (e) {
      var el = document.activeElement, tag = el && el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
      if (e.key === 'Escape' && document.body.classList.contains('theater')) { e.preventDefault(); setTheater(false); }
      else if ((e.key === 't' || e.key === 'T') && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setTheater(!document.body.classList.contains('theater')); }
    });

    // Auto-advance to the next episode when this one ends.
    if (D.next) {
      v.addEventListener('ended', function () { markWatched(D.id); window.location.href = '/watch/' + D.next; });
    } else {
      v.addEventListener('ended', function () { markWatched(D.id); });
    }

    // Dim episodes already watched, then keep the current one in view.
    var watched = readWatched();
    document.querySelectorAll('.eprow').forEach(function (a) {
      if (a.classList.contains('current')) return;
      var href = a.getAttribute('href') || '';
      var epId = href.slice(href.lastIndexOf('/') + 1);
      if (epId && watched[epId]) a.classList.add('watched');
    });
    var cur = document.querySelector('.eprow.current');
    if (cur) cur.scrollIntoView({ block: 'center' });

    load(true);                                // first load -> resume saved position
    if (state.subs != null) setSub(state.subs); // restore saved subtitle track (overlay)
  })();
</script>
</body></html>`);
});

// Poster proxy
app.get('/img/:id', async (req, res) => {
  await ensureScope().catch(() => {});
  const { id } = req.params;
  if (!playableIds.has(id) && !isCollectionItem(id)) return res.status(404).end();
  await proxy(req, res, jfUrl(`/Items/${id}/Images/Primary`, { maxWidth: '400', quality: '90' }));
});

// HLS entry point: build the master playlist request with transcode params.
app.get('/api/play/:id/master.m3u8', async (req, res) => {
  const { id } = req.params;
  try { await ensureScope(); } catch { return res.status(502).end(); }
  if (!playableIds.has(id)) return res.status(403).end();

  const params = {
    MediaSourceId: id,
    VideoCodec: 'h264',
    AudioCodec: 'aac,mp3',
    SegmentContainer: 'ts',
    TranscodingMaxAudioChannels: '2',
    BreakOnNonKeyFrames: 'true',
    MinSegments: '2',
    PlaySessionId: crypto.randomUUID(),
  };
  // Audio / quality selection (validated as ints so nothing arbitrary reaches
  // JF). Subtitles are deliberately NOT burned in here — they're delivered as
  // separate ASS via /api/sub and rendered client-side with JASSUB. That keeps
  // the video transcode independent of the subtitle choice, so toggling or
  // switching subtitles no longer restarts ffmpeg from scratch.
  const audio = parseInt(req.query.audio, 10);
  if (Number.isInteger(audio)) params.AudioStreamIndex = audio;
  const h = parseInt(req.query.h, 10);
  if (Number.isInteger(h) && h > 0) params.maxHeight = h;
  const vb = parseInt(req.query.vb, 10);
  if (Number.isInteger(vb) && vb > 0) params.videoBitRate = vb;

  const url = jfUrl(`/Videos/${id}/master.m3u8`, params);
  await proxy(req, res, url, { isPlaylist: true });
});

// HLS sub-playlists + segments. Relative URIs in the playlists resolve under
// /api/play/:id/ and map 1:1 onto Jellyfin's /Videos/:id/ — so we just pass the
// path + the params Jellyfin embedded, adding the api_key server-side.
app.get('/api/play/:id/*', async (req, res) => {
  const { id } = req.params;
  try { await ensureScope(); } catch { return res.status(502).end(); }
  if (!playableIds.has(id)) return res.status(403).end();

  const rest = req.params[0]; // e.g. "main.m3u8" or "hls1/main/0.ts"
  const url = jfUrl(`/Videos/${id}/${rest}`);
  // carry through every query param the player received (PlaySessionId, etc.)
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== 'api_key') url.searchParams.set(k, v);
  }
  await proxy(req, res, url);
});

// Text-subtitle delivery (rendered client-side by JASSUB). Jellyfin converts any
// text track — ASS/SSA passthrough, SubRip transcoded — to ASS, so a single path
// covers every subtitle. Serving them separately (instead of burning them into
// the video) means switching tracks never restarts the transcode.
app.get('/api/sub/:id/:index', async (req, res) => {
  const { id } = req.params;
  try { await ensureScope(); } catch { return res.status(502).end(); }
  if (!playableIds.has(id)) return res.status(403).end();
  const index = parseInt(req.params.index, 10);
  if (!Number.isInteger(index) || index < 0) return res.status(400).end();

  const url = jfUrl(`/Videos/${id}/${id}/Subtitles/${index}/0/Stream.ass`);
  res.set('cache-control', 'public, max-age=86400'); // subtitles are static per item
  res.set('access-control-allow-origin', '*');       // JASSUB's worker may fetch cross-origin
  await proxy(req, res, url);
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`boop-watch listening on :${PORT}  (collection ${COLLECTION_ID})`);
  refreshScope()
    .then(() => console.log(`scope loaded: ${collectionItems.length} items, ${playableIds.size} playable`))
    .catch((e) => console.error('initial scope load failed:', e.message));
});
