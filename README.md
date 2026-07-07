# boop-watch

A public, **no-login** streaming portal for a curated subset of a private Jellyfin server, plus an
authenticated **library manager**. The portal serves only the titles in one Jellyfin collection
("Public"), keeps the Jellyfin API key server-side, and proxies posters + HLS so the token never
reaches the browser.

Live at **watch.boopurno.es**.

## Features

Public portal:
- Poster-forward **catalog** with live filter, sort (name/year/type), and collapsible genre/type tags
- **Series** and **movie** detail pages (hero, metadata, synopsis, episodes / Play)
- Token-stripping **HLS player** (hls.js) with client-side subtitles (JASSUB), audio/quality menus,
  resume, theater mode, and auto-advance
- Command-palette **search** that jumps straight to a title
- Weekly anime **schedule** (sourced from animeschedule.net), filtered to titles in the library,
  with sub/dub labels and prev/next week navigation
- Dark, violet-accent "Kagura" design system; mobile-friendly

Library manager (`/manage`, login required):
- Search MyAnimeList (via Jikan), add titles to a SQLite catalog, browse metadata + episodes

## Stack
React (Vite) + TypeScript SPA served by an Express 5 + better-sqlite3 backend. Two design systems:
the portal's "Kagura" (`src/kagura.css`) and shadcn/Tailwind for the admin. See
**[CLAUDE.md](./CLAUDE.md)** for architecture and development guidance.

## Run
```bash
# install + build (frontend -> dist, backend -> dist-server)
npm ci && npm run build:all

# production: serve the built app
NODE_ENV=production JELLYFIN_API_KEY=… WATCH_COLLECTION_ID=… node dist-server/index.js   # :3000

# local dev: Vite + backend (proxied) in two terminals
npm run server:dev      # backend on :3001
npm run dev             # Vite dev server (proxies /api and /img)
```

| Env var | Required | Default |
|---|---|---|
| `JELLYFIN_API_KEY` | portal | — |
| `WATCH_COLLECTION_ID` | portal | — |
| `JELLYFIN_URL` | no | `http://jellyfin:8096` |
| `SCHEDULE_TZ` | no | `America/New_York` |
| `DATA_DIR` | no | `./data` (holds `series.sqlite`) |
| `JWT_SECRET` / `AUTH_USERNAME` / `AUTH_PASSWORD` | `/manage` | insecure dev defaults |
| `PORT` | no | `3000` |

Deploy is automated across two environments (`link-apps` namespace): pushing to `dev` builds & moves
`ghcr.io/n0es/boop-watch:dev` → the `deploy-dev` job rolls `boop-watch-dev` (staging); pushing to
`main` moves `:latest` → the `deploy` job rolls `boop-watch` (production). Normal flow: feature
branch → PR to `dev` (CI `build` green, then merge = deploy to staging), verify the PR's test plan
on staging, then promote with a `dev` → `main` PR.

## Curate
Add or remove titles from the **"Public"** collection in Jellyfin. The portal's scope cache
refreshes every 5 minutes (or restart the container).
