# CLAUDE.md — boop-watch

Guidance for AI agents (and humans) working in this repo. Read this before editing.

## What this is

`boop-watch` is two surfaces in one app:

1. A **public, no-login streaming portal** for a *curated subset* of a private Jellyfin server. It
   exposes only the titles in one Jellyfin collection ("Public"), holds the Jellyfin admin API key
   **server-side**, and proxies posters + HLS so the token never reaches the browser. Live at
   `watch.boopurno.es`.
2. An **authenticated library manager** at `/manage` (JWT) — a Jikan/MyAnimeList metadata catalog
   stored in SQLite (`series.sqlite`). This is the merged-in `n0es/anime-indexer`.

It is a **React (Vite) + TypeScript SPA** served by an **Express + better-sqlite3** backend. There
**is** a build step (this replaced the old single-file, server-rendered `server.js` — kept as
`server.legacy.cjs` for reference only; do not run or extend it).

## Layout

```
index.html              # Vite entry; <html class="dark">, loads Geist fonts
vite.config.ts          # React + Tailwind v4; dev proxies /api and /img -> :3001
src/                    # React SPA
  main.tsx              # imports index.css (shadcn) + kagura.css (portal)
  App.tsx               # routes: public portal at root, admin under /manage + /login
  kagura.css            # the "Kagura" design system, scoped under .kagura / .player
  index.css             # Tailwind + shadcn tokens (admin), dark theme aligned to Kagura
  lib/api.ts            # typed client for the public JSON APIs
  components/           # Icon, Chrome (header+search), PortalLayout; ui/* = shadcn (admin)
  pages/                # Browse, Title, SchedulePage, Watch (public); Login, Dashboard,
                        #   SeriesDetail (admin)
server/                 # Express backend (TypeScript, ESM)
  index.ts              # wiring: publicRouter -> auth/series APIs -> static dist + SPA fallback
  jellyfin.ts           # JF helpers, scope cache, api_key-stripping HLS proxy
  publicRoutes.ts       # public portal routes + JSON APIs (no auth)
  watch.ts, schedule.ts # player stream-info; animeschedule scraper + library matcher
  db.ts, jikan.ts       # series.sqlite + Jikan/MAL client (the /manage admin)
Dockerfile              # multi-stage node:20-alpine; builds dist + dist-server
public/robots.txt       # Disallow: / (the portal is unlisted)
```

Build output: `dist/` (frontend) + `dist-server/` (compiled backend), both gitignored. In
production the server serves `dist/` statically and falls back to `index.html` for non-`/api`,
non-file GETs (the SPA router).

## Run / build / deploy

**Deploy is automated via GitHub → GHCR → Watchtower.** Merging to `main` triggers
`.github/workflows/docker-publish.yml` (install + `npm run build:all`, then build & push
`ghcr.io/n0es/boop-watch:latest`). The host's Watchtower polls GHCR every 30s and auto-redeploys
the `boop-watch` container (`com.centurylinklabs.watchtower.enable=true`). **You don't run a manual
build to deploy — open a PR, merge it, and the new image rolls out on its own.** Every PR also
builds (no push) as a CI check.

```bash
npm run build:all     # tsc -b && vite build  +  tsc -p server/tsconfig.json  (CI does this)
npm run dev           # Vite dev server (proxies /api + /img to the backend)
npm run server:dev    # tsx watch server/index.ts  (backend on :3001)

# smoke test (runs inside the container; the app listens on :3000)
docker exec boop-watch wget -qO- http://localhost:3000/health        # -> ok

# force an immediate pull instead of waiting for Watchtower's 30s poll
cd /opt/boopurnoes && docker compose pull boop-watch && docker compose up -d boop-watch
```

The compose service `boop-watch` (`image: ghcr.io/n0es/boop-watch:latest`) sits on the `proxy`
network behind Traefik (`conf.d/watch.yml`, no auth middleware — auth is per-route in the app).
The public DNS record is **grey-clouded** (Cloudflare proxy off) so video bypasses CF's free-tier
video ToS. The compose file lives at `/opt/boopurnoes/docker-compose.yml` (not in this repo, not in
git). The SQLite DB needs a persistent volume mounted at `DATA_DIR`.

### Environment variables
- `JELLYFIN_URL` — base URL (default `http://jellyfin:8096`)
- `JELLYFIN_API_KEY` — admin key, server-side only. **Required** for the public portal; if unset the
  portal routes 503 (the app still boots so `/manage` works).
- `WATCH_COLLECTION_ID` — the "Public" BoxSet id (same requirement as above)
- `SCHEDULE_TZ` — schedule timezone (default `TZ` env, else `America/New_York`)
- `DATA_DIR` — where `series.sqlite` lives (default `./data`; set to a mounted volume in prod)
- `JWT_SECRET`, `AUTH_USERNAME`, `AUTH_PASSWORD` — `/manage` login (defaults are insecure dev values)
- `NODE_ENV=production` — serve the built `dist/`
- `PORT` — default `3000` (the Dockerfile sets it; the dev backend defaults to `3001`)

## Routes

Public portal — SPA routes served by `index.html`: `/`, `/series/:id`, `/movie/:id`, `/watch/:id`,
`/schedule`. They consume these **public JSON APIs / passthroughs** (no auth, all behind the scope
guard):

| Route | Purpose |
|---|---|
| `GET /api/catalog` / `GET /api/catalog/:id` | Browse list / title detail (series or movie) |
| `GET /api/watch/:id` | Player metadata (audio/sub/quality tracks + sibling episodes) |
| `GET /api/schedule` | Weekly anime airings (animeschedule.net), library-filtered |
| `GET /img/:id` | Poster proxy (Jellyfin Primary image) |
| `GET /api/play/:id/master.m3u8`, `/api/play/:id/*splat` | HLS proxy (strips `api_key`) |
| `GET /api/sub/:id/:index` | Subtitle (ASS) delivery for client-side JASSUB |
| `GET /health` | `ok` |

Admin (JWT, `requireAuth`): `POST /api/login`, `/api/logout`, `GET /api/me`,
`GET /api/search/anime`, `GET|POST /api/series`, `GET /api/series/:id/detail`,
`/api/series/:id/episodes`, `DELETE /api/series/:id`.

Every public content route runs through the **scope guard**: it 403s/404s unless the id is in the
Public collection (`isCollectionItem` / `getPlayableIds`). Never bypass it.

## Conventions — match these

- **Two design systems, cleanly separated.** The portal uses the **"Kagura"** language (dark, violet
  accent, Geist / Geist Mono) in `src/kagura.css`, **scoped under `.kagura` / `.player`** so it never
  collides with the admin. Match the component classes (`.poster-card`, `.badge`, `.panel`, `.btn`,
  `.evt`, `.chip`, `.pmenu`, …) and the CSS custom properties (`--bg`, `--fg-muted`, `--accent`, …);
  **don't hardcode colors**. The admin uses **shadcn/Tailwind** (`src/index.css`), whose dark tokens
  are aligned to Kagura's violet. The whole app runs in dark mode (`<html class="dark">`).
- **Icons** via the `Icon` component (`src/components/Icon.tsx`, `ICONS` map).
- **All Jellyfin access is server-side.** The browser never sees the API key. The HLS proxy
  (`stripCreds` in `server/jellyfin.ts`) removes `api_key`/`ApiKey` from playlist bodies — preserve
  that. Subtitles are delivered separately via `/api/sub` and rendered client-side (JASSUB), so
  switching tracks never restarts the transcode.
- **Express 5 routing:** wildcards must be **named** (`/api/play/:id/*splat`, read via
  `req.params.splat`) — not the v4 bare `*` / `req.params[0]`.
- **TypeScript is strict** (and the app build runs `noUnusedLocals`/`noUnusedParameters`). Use
  `import type` for type-only imports (verbatimModuleSyntax).

## Data-source gotchas (load-bearing — don't relearn the hard way)

- **Jellyfin single-item metadata:** the bare `GET /Items/{id}` route **500s** on our server
  (wants a user context). Use `jfItem(id, fields)` which goes through `/Items?Ids=…`.
- **Scope cache** refreshes every 5 min. After changing the Public collection, restart the
  container or wait — otherwise new/removed titles won't show.
- **animeschedule.net:** we **scrape the homepage** (`/?year=Y&week=W`). The official v3 API needs
  a Bearer **App Token** (the OAuth *client secret* 401s — not the same thing). The current-week
  homepage **reorders today's column**, so derive the Mon–Sun window from the airings' own dates,
  not the column markup. Week nav relays the page's own prev/next links. Cache per week, 30 min.
- **Schedule ↔ library matching:** animeschedule uses romaji, Jellyfin often stores English
  (TheTVDB). `libraryMatcher` (in `server/schedule.ts`) bridges them via shared distinctive tokens
  (e.g. "slime", "zero"), restricted to library *series*; kanji-only `OriginalTitle`s need a
  `TITLE_ALIASES` entry. Deliberately loose but scoped to the small curated set.
- **Jikan/MAL (admin):** the `/manage` catalog uses the public Jikan v4 API (rate-limited ~3 req/s);
  it dedupes repeated `mal_id`s. Episode numbers are parsed from MAL episode URLs.

## When you change something
1. `npm run build:all` (typechecks frontend + server; CI runs this and the Docker build).
2. For real verification, run the built server and exercise it — the host can reach the Jellyfin
   container directly (e.g. `JELLYFIN_URL=http://[redacted-docker-ip]:8096`), and the host-built
   `better-sqlite3` is glibc-native so `node dist-server/index.js` runs locally. The public JSON
   APIs and a headless browser (Playwright) screenshot are the way to verify UI; you can't rely on
   server-rendered HTML anymore (it's a client-rendered SPA).
3. **Bump the version in every PR.** Increment `version` in `package.json` (semver: patch for
   fixes, minor for features, major for breaking changes). This is the single source of truth —
   `src/version.ts` re-exports it and the portal footer renders it as `v<version>`, so a bump is how
   a deploy becomes visibly identifiable. One bump per PR.
4. **Always commit your changes** when work is complete — don't leave the tree dirty. Use a
   **branch-and-PR flow**: feature branch, commit, push to `origin`, open a PR into `main`
   (`gh pr create`). **Don't commit directly to `main`.** If the tree already had unrelated pending
   changes, call that out rather than bundling them. Remote: `github.com/n0es/boop-watch` (private).
