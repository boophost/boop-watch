# CLAUDE.md — boop-watch

Guidance for AI agents (and humans) working in this repo. Read this before editing.

## What this is

`boop-watch` is a **public, no-login streaming portal** for a *curated subset* of a private
Jellyfin server. It exposes only the titles in one Jellyfin collection ("Public"), holds the
Jellyfin admin API key **server-side**, and proxies posters + HLS so the token never reaches the
browser. Live at `watch.boopurno.es`.

It is a single, dependency-light Node/Express app that **server-renders HTML** — no client
framework, no bundler, no build step beyond `npm install`.

## Layout

```
server.js        # the entire app: routes, Jellyfin proxy, HTML rendering, CSS, client JS
package.json     # one dependency: express
Dockerfile       # node:20-slim; installs wget (compose healthcheck), copies server.js + public/
public/robots.txt# Disallow: / (the portal is unlisted)
```

`server.js` is intentionally one file (~1.3k lines). Sections, top to bottom: Jellyfin helpers →
scope cache → HLS/stream proxy → HTML helpers (`page`, `header`, `esc`, `svg`, `STYLE`) → routes →
schedule scraper → `app.listen`. Keep this ordering; add new routes among the existing ones.

## Run / build / deploy

This service is **built and run by the parent compose file**, not from this directory directly:

```bash
# deploy a change (from the compose root, /opt/boopurnoes)
cd /opt/boopurnoes && docker compose up -d --build boop-watch

# syntax check before rebuilding
node --check boop-watch/server.js

# smoke test (runs inside the container; the app listens on :3000)
docker exec boop-watch wget -qO- http://localhost:3000/health        # -> ok
docker exec boop-watch wget -qO- http://localhost:3000/ | head
```

The compose service `boop-watch` (`build: ./boop-watch`) sits on the `proxy` network behind
Traefik (`conf.d/watch.yml`, no auth middleware). The public DNS record is **grey-clouded**
(Cloudflare proxy off) so video bypasses CF's free-tier video ToS.

Local dev without Docker: `JELLYFIN_API_KEY=… WATCH_COLLECTION_ID=… node server.js`.

### Environment variables
- `JELLYFIN_URL` — base URL (default `http://jellyfin:8096`)
- `JELLYFIN_API_KEY` — **required**, admin key, server-side only
- `WATCH_COLLECTION_ID` — **required**, the "Public" BoxSet id
- `SCHEDULE_TZ` — schedule timezone (default `TZ` env, else `America/New_York`)
- `PORT` — default `3000`

## Routes

| Route | Purpose |
|---|---|
| `GET /` | Browse grid of the Public collection (filter / sort / tag chips) |
| `GET /series/:id` | Series detail — hero + episode list |
| `GET /movie/:id` | Movie detail — hero + Play button |
| `GET /watch/:id` | hls.js player |
| `GET /schedule` | Weekly anime airings (animeschedule.net), library-filtered, prev/next weeks |
| `GET /img/:id` | Poster proxy (Jellyfin Primary image) |
| `GET /api/play/:id/master.m3u8`, `/api/play/:id/*` | HLS proxy (strips `api_key`) |
| `GET /health` | `ok` |

Every content route runs through the **scope guard**: a request 403s/404s unless the id is in the
Public collection (`isCollectionItem` / `playableIds`). Never bypass it.

## Conventions — match these

- **Server-rendered HTML in template literals.** Always escape interpolated data with `esc()`.
  Icons via `svg(name, size)` (`ICONS` map). Shared chrome via `page()` / `header()` /
  `detailShell()`.
- **One design system.** All styling lives in the `STYLE` constant — the "Kagura" design language
  (dark, violet accent, Geist / Geist Mono), ported from a Claude Design handoff. Use the CSS
  custom properties (`--bg`, `--fg-muted`, `--accent`, `--border`, …). **Do not hardcode colors**;
  add or reuse a token. Match the existing component classes (`.poster-card`, `.badge`, `.panel`,
  `.btn`, `.evt`, `.chip`, …).
- **Client JS is small vanilla IIFEs** embedded in the page (filter/sort, search palette, day
  switcher, week nav). No frameworks, no bundler. Keep them dependency-free and inline.
- **All Jellyfin access is server-side.** The browser never sees the API key. The HLS proxy
  (`stripCreds`) removes `api_key`/`ApiKey` from playlist bodies; preserve that.
- **No build step.** A change to `server.js` is live after a container rebuild. Don't introduce a
  toolchain unless asked.

## Data-source gotchas (load-bearing — don't relearn the hard way)

- **Jellyfin single-item metadata:** the bare `GET /Items/{id}` route **500s** on our server
  (wants a user context). Use `jfItem(id, fields)` which goes through `/Items?Ids=…`.
- **Poster image layering:** the `<img>` must be `position:absolute` over the `.poster-fallback`
  (the fallback is absolutely positioned and would otherwise paint on top, hiding the image).
- **Scope cache** refreshes every 5 min. After changing the Public collection, restart the
  container or wait — otherwise new/removed titles won't show.
- **animeschedule.net:** we **scrape the homepage** (`/?year=Y&week=W`). The official v3 API needs
  a Bearer **App Token** (the OAuth *client secret* 401s — not the same thing). The current-week
  homepage **reorders today's column**, so derive the Mon–Sun window from the airings' own dates,
  not the column markup. Week nav relays the page's own prev/next links (no week-number math).
  Cache per week, 30 min.
- **Schedule ↔ library matching:** animeschedule uses romaji, Jellyfin often stores English
  (TheTVDB). `libraryMatcher` bridges them via shared distinctive tokens (e.g. "slime", "zero"),
  restricted to library *series*. It is deliberately loose but scoped to the small curated set.

## When you change something
1. `node --check boop-watch/server.js`
2. `cd /opt/boopurnoes && docker compose up -d --build boop-watch`
3. Smoke-test the affected route via `docker exec boop-watch wget -qO- …`.
4. UI changes can't be screenshot here — reason about layout from the CSS, and verify markup/data
   attributes in the served HTML.
5. **Always commit your changes** when work is complete — don't leave the tree dirty. Use a
   **branch-and-PR flow**: create a feature branch, commit there, push to `origin`, and open a PR
   into `main` (`gh pr create`). **Don't commit directly to `main`.** If the working tree already
   had unrelated pending changes, call that out in the commit/PR description rather than silently
   bundling them as your own. Remote: `github.com/n0es/boop-watch` (private).
