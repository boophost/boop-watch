# boop-watch

A public, **no-login** streaming portal for a curated subset of a private Jellyfin server.
It serves only the titles in one Jellyfin collection ("Public"), keeps the Jellyfin API key
server-side, and proxies posters + HLS so the token never reaches the browser.

Live at **watch.boopurno.es**.

## Features
- Poster-forward **catalog** with live filter, sort (name/year/type), and collapsible genre/type tags
- **Series** and **movie** detail pages (hero, metadata, synopsis, episodes / Play)
- Token-stripping **HLS player** (hls.js)
- Command-palette **search** that jumps straight to a title
- Weekly anime **schedule** (sourced from animeschedule.net), filtered to titles in the library,
  with sub/dub labels and prev/next week navigation
- Dark, violet-accent "Kagura" design system; mobile-friendly

## Stack
Single Node/Express app that server-renders HTML — no client framework, no bundler. One runtime
dependency (`express`). See **[CLAUDE.md](./CLAUDE.md)** for architecture and development guidance.

## Run
```bash
# via the parent docker-compose (production)
cd /opt/boopurnoes && docker compose up -d --build boop-watch

# or locally
JELLYFIN_URL=http://localhost:8096 \
JELLYFIN_API_KEY=… \
WATCH_COLLECTION_ID=… \
node server.js          # listens on :3000
```

| Env var | Required | Default |
|---|---|---|
| `JELLYFIN_API_KEY` | yes | — |
| `WATCH_COLLECTION_ID` | yes | — |
| `JELLYFIN_URL` | no | `http://jellyfin:8096` |
| `SCHEDULE_TZ` | no | `America/New_York` |
| `PORT` | no | `3000` |

## Curate
Add or remove titles from the **"Public"** collection in Jellyfin. The portal's scope cache
refreshes every 5 minutes (or restart the container).
