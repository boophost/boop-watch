# boop-watch

A sleek, **no-login** streaming portal for a curated subset of a private Jellyfin server, paired with an authenticated **library manager** (`/manage`). 

`boop-watch` was built to provide a friction-free, beautiful frontend for a specific Jellyfin collection (e.g., "Public"), keeping the Jellyfin API key entirely server-side. It proxies image assets and HLS streams so that backend authentication tokens never reach the browser.

Live at **[watch.boopurno.es](https://watch.boopurno.es)**.

## Features

**Public Portal:**
- Poster-forward **catalog** with live filtering, sorting (name/year/type), and collapsible genre/type tags.
- **Series** and **movie** detail pages featuring hero banners, metadata, synopses, and episode lists.
- Token-stripping **HLS player** (via `hls.js`) with client-side subtitles (JASSUB), quality menus, resume functionality, theater mode, and auto-advance.
- Command-palette **search** that jumps straight to a title.
- Weekly anime **schedule** (sourced from animeschedule.net), filtered dynamically to titles present in your library, with sub/dub labels and week-to-week navigation.
- A custom, dark, violet-accented **Kagura** design system that is fully mobile-responsive.

**Library Manager (`/manage`):**
- Authenticated administration panel (built with shadcn/Tailwind).
- Search MyAnimeList (via Jikan API), add titles to a SQLite catalog, and browse metadata/episodes.
- Manage visual flow graphs (stored in SQLite) via MCP for advanced data-pipeline processing.

## Tech Stack

- **Frontend:** React (Vite) + TypeScript SPA.
- **Backend:** Express 5 + `better-sqlite3`.
- **Design Systems:** "Kagura" (`src/kagura.css`) for the public portal, shadcn/Tailwind for the admin dashboard.

See **[CLAUDE.md](./CLAUDE.md)** and **[AGENTS.md](./AGENTS.md)** for architecture and contribution guidelines.

## Quick Start

### Build & Run
```bash
# Install dependencies and build both frontend and backend
npm ci && npm run build:all

# Run in production mode
NODE_ENV=production \
JELLYFIN_API_KEY=your_key \
WATCH_COLLECTION_ID=your_collection_id \
node dist-server/index.js
```

### Local Development
Run Vite and the proxied Express backend in two separate terminals:
```bash
npm run server:dev      # Starts backend on :3001
npm run dev             # Starts Vite dev server on :5173 (proxies /api and /img)
```

## Environment Variables

| Variable | Required | Default / Note |
|---|---|---|
| `JELLYFIN_API_KEY` | Yes (Portal) | Admin key required to fetch Jellyfin data. |
| `WATCH_COLLECTION_ID` | Yes (Portal) | The Jellyfin collection ID to expose on the portal. |
| `JELLYFIN_URL` | No | `http://jellyfin:8096` |
| `SCHEDULE_TZ` | No | `America/New_York` |
| `DATA_DIR` | No | `./data` (Holds the `series.sqlite` database and flow graphs) |
| `ADMIN_EMAILS` | No | Comma-separated list of emails allowed to log in. |
| `JWT_SECRET` | No | Insecure dev default used if unset. |
| `AUTH_USERNAME` | No | Insecure dev default (`admin`) used if unset. |
| `AUTH_PASSWORD` | No | Insecure dev default (`changeme`) used if unset. |
| `PORT` | No | `3000` |
| `JIKAN_URL` | No | Self-hosted Jikan REST API for ID lookups (defaults to public API). |
| `JIKAN_SEARCH_URL`| No | Public Jikan API for searches (defaults to `https://api.jikan.moe/v4`). |

## Deployment & CI/CD

Deployment is automated via GitHub Actions:
- Pushing to the `dev` branch builds the `:dev` image and rolls the staging deployment (`boop-watch-dev`).
- Pushing to the `main` branch builds the `:latest` image and rolls the production deployment (`boop-watch`).

**Standard Workflow:** 
Feature Branch → PR to `dev` (Validates build & deploys to Staging) → Verify Staging Health → PR to `main` (Promotes to Production).

## Curation

To add or remove titles from the public portal, simply add or remove them from your configured "Public" collection in Jellyfin. The portal's scope cache will automatically refresh every 5 minutes (or immediately upon container restart).

*Note: For internal infrastructure details, organization operators should refer to the private `boop-watch-ops` repository.*
