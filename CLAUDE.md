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
Dockerfile              # multi-stage node:22-alpine; builds dist + dist-server
public/robots.txt       # Disallow: / (the portal is unlisted)
```

Build output: `dist/` (frontend) + `dist-server/` (compiled backend), both gitignored. In
production the server serves `dist/` statically and falls back to `index.html` for non-`/api`,
non-file GETs (the SPA router).

## Run / build / deploy

**Deploy is automated via GitHub → GHCR → k3s, with two environments.** Pushing to `main` **or**
`dev` triggers `.github/workflows/docker-publish.yml`: the `build` job installs + `npm run build:all`
and pushes the image with a moving tag per branch (plus a per-commit `type=sha` tag). Then a
branch-scoped deploy job rolls the matching k3s Deployment, which is pinned to that moving tag:

| Branch | Image tag | Deploy job | k3s Deployment | Environment |
|---|---|---|---|---|
| `main` | `:latest` (+ sha) | `deploy` | `boop-watch` | production (`watch.boopurno.es`) |
| `dev` | `:dev` (+ sha) | `deploy-dev` | `boop-watch-dev` | dev/staging (`kubectl` only, no public URL yet) |

**`dev` is the integration/staging trunk — feature work reaches it through a PR.** Work on a
short-lived feature branch, open a **feature → `dev` PR** with a test-plan checklist, and wait for
the CI `build` check to go green. **Merging that PR *is* the deploy-to-staging step, not the end of
the change**: the merge push builds `:dev` and rolls `boop-watch-dev`, where you then **verify it
works** (see below) and check off the PR's test plan on the merged PR page. Only when the staging
checklist is green is the change done; production comes later via a reviewed **`dev` → `main` PR**.
You don't run a manual build to deploy. Every push to `dev`/`main` deploys; PR builds are a CI
check with no push. **Both moving tags must exist for the pods to pull** — `:latest` comes from a
`main` push, `:dev` from a `dev` push (a Deployment pinned to a tag that was never published
`ImagePullBackOff`s).

The app now runs on a **k3s cluster** (control plane `k8s-cp`, `[redacted-lan-ip]`), provisioned by the
`n0es/link` platform: the `boop-watch` (prod) and `boop-watch-dev` (staging) Deployments/Services
live in the **`link-apps`** namespace with `link.boopurno.es/app` labels. link sets
`imagePullPolicy: Always` + a changing `link.dev/deployed-at` pod annotation, but a *running* pod
never re-pulls a moved tag on its own — so the deploy job runs `kubectl rollout restart` (same effect
as link's redeploy) to force the new pod to pull the freshly pushed image. It is **not** a
Watchtower/compose deploy anymore (the old `boop-watch` compose service on `boopurnoes` is
retired/stopped).

Both `deploy` (prod) and `deploy-dev` run on the **self-hosted runner on `k8s-cp`** (label `k3s-cp`)
because the k3s API is LAN-only, and each is gated by `github.ref` so only the matching branch's job
runs. They authenticate with a token scoped (RBAC `Role` in `link-apps`) to `get/list/watch/patch`
deployments — not cluster-admin — via kubeconfig `$HOME/.kube/boop-watch-deployer.yaml` on that host.
Manual roll if ever needed: `kubectl -n link-apps rollout restart deployment/boop-watch` (or
`deployment/boop-watch-dev`).

```bash
npm run build:all     # tsc -b && vite build  +  tsc -p server/tsconfig.json  (CI does this)
npm run dev           # Vite dev server (proxies /api + /img to the backend)
npm run server:dev    # tsx watch server/index.ts  (backend on :3001)

# smoke test a running pod (the app listens on :3000 in-container)
kubectl -n link-apps exec deploy/boop-watch     -- wget -qO- http://localhost:3000/health   # prod
kubectl -n link-apps exec deploy/boop-watch-dev -- wget -qO- http://localhost:3000/health   # staging
```

**Verify a change on staging after merging to `dev`** (the host has `kubectl` access to the LAN
cluster — you don't need the self-hosted runner to *check*):

```bash
kubectl -n link-apps rollout status deployment/boop-watch-dev --timeout=180s   # wait for the roll
kubectl -n link-apps get pods -l link.boopurno.es/app=boop-watch-dev           # expect 1/1 Running
kubectl -n link-apps exec deploy/boop-watch-dev -- wget -qO- http://localhost:3000/health   # -> ok
# exercise the real APIs against staging without a public URL:
kubectl -n link-apps port-forward deploy/boop-watch-dev 8080:3000 &            # then curl :8080/api/…
```

`boop-watch-dev` has **no ingress yet** (ClusterIP only), so it's reachable via `exec`/`port-forward`,
not a browser URL. Give it its own `JELLYFIN_API_KEY` / `WATCH_COLLECTION_ID` (portal routes 503
without them). A public `dev.watch.boopurno.es`-style route would be a follow-up (add an ingress in
the `link` platform).

`watch.boopurno.es` is served through the `link`/k3s ingress path (MetalLB), not the old
`boopurnoes` Traefik route. The public DNS record is **grey-clouded** (Cloudflare proxy off) so video
bypasses CF's free-tier video ToS. The SQLite DB needs a persistent volume (the k3s app `Volume` /
PVC, mounted at `DATA_DIR`).

### Library-import flow (custom indexer → library)

The **"Library import"** seed flow (`server/flowsDb.ts`) takes over where the "Missing videos"
flow stops: it turns completed qBittorrent downloads into files in the media library. Chain:
`source.qbittorrent` (completed) → `transform.expand-files` (torrent → per-episode video files) →
`enrich.indexer-match` (release → catalog `mal_id`) → `enrich.metadata` (MAL metadata into our own
catalog DB + `production_year` for the path) → `enrich.media-probe` (ffprobe subtitle facts) →
`filter.compare` on `sub_langs` → `enrich.extract-subs` (keep the embedded ASS) **or**
`enrich.fetch-subs` (Jimaku replacement) → `sink.library-import` (hardlink into `LIBRARY_DIR`,
sidecars alongside) → `sink.jellyfin-scan`. Run it on a schedule (files finish *after* the magnet is
queued). Sorting/scoring/branching is done with the general `filter.compare` / `filter.sort` /
`transform.compute` / `combine.group-pick` nodes — **don't hardcode that logic into domain nodes.**

**This flow needs the media storage mounted into the pod.** Downloads and the Jellyfin library are
**one NFS export** — `[redacted-nfs-export]` (qBittorrent on boopurnoes bind-mounts it at `/data`;
Jellyfin/tdarr mount it via `media-nfs-pvc`; layout: `downloads/`, `anime/`, `anime-movies/`,
`movies/`). Mount that same export **at `/data`** in the pod: then qBit's reported
`content_path=/data/downloads/…` resolves with **no** `pathFrom`/`pathTo` remap, and set
`LIBRARY_DIR=/data/anime`. Because downloads and library are the **same filesystem**,
`sink.library-import` **hardlinks** (verified: shared inode; it falls back to a copy across
filesystems). `link` supports this via its NFS-mount field (added in `n0es/link` for issue #54).
`ffmpeg`/`ffprobe` are in the image for the probe/extract nodes. The `mcp/` CLI (see `mcp/README.md`)
drives flows against a port-forwarded staging backend for iteration.

### Flows/schedules live in the DB, not git — promoting code never promotes them

Flow graphs, published components, and schedules are rows in each environment's own `series.sqlite`
(`flows`, `flow_schedules` tables) — **not** checked into the repo. A `dev` → `main` PR ships *code*
(node types, server logic); it never touches production's actual flow graphs or schedule cadence.
If you build/edit a flow on staging (new node, rewired graph, new published component), it exists
**only on staging** until you manually replicate it on production too — there is no automated sync,
and this is a deliberate choice (no tooling for it yet — see below), not a bug.

**Manual replication recipe** (e.g. porting a staging-only flow edit to prod):
1. Port-forward both environments' backends (`kubectl -n link-apps port-forward deploy/boop-watch-dev 3001:3000` and `deploy/boop-watch 3002:3000`), mint a JWT for each from that pod's own `JWT_SECRET` (they differ per environment).
2. **Fetch the target environment's *current* graph fresh — never blindly copy the source environment's graph.** Environments drift (e.g. prod's `enrich.indexer-match` had a `seasonField` config dev's didn't; prod's `sink.library-import` had no explicit `pathTemplate` override while dev did) — copying wholesale silently clobbers real prod-only config. Diff node-by-node (`id`, `type`, `config`) before touching anything.
3. Apply the same structural edit (insert/rewire nodes) to the target's own fetched graph, preserving every other node's config untouched.
4. If the edit references a published component (a `flow.subflow` node's `flowId`), that component must be created + published **separately on the target environment first** — flow IDs are per-database and will not match across environments (e.g. a component published as flow #37 on dev may land as flow #26 on prod).
5. Save via the `mcp/` CLI (`node mcp/flows-server.mjs save <id> <graph.json>`), then **dry-run it** (`run <id>`, no `--live`) before trusting it — a dry-run against real queued/completed torrents will actually exercise the new logic (ffprobe, matching, etc.) against live data without writing anything, which is a strong correctness signal.

No import/export or diff tooling exists for this yet (discussed and deliberately deferred — this stays
a manual process for now).

### Environment variables
- `JELLYFIN_URL` — base URL (default `http://jellyfin:8096`)
- `JELLYFIN_API_KEY` — admin key, server-side only. **Required** for the public portal; if unset the
  portal routes 503 (the app still boots so `/manage` works).
- `WATCH_COLLECTION_ID` — the "Public" BoxSet id (same requirement as above)
- `SCHEDULE_TZ` — schedule timezone (default `TZ` env, else `America/New_York`)
- `DATA_DIR` — where `series.sqlite` lives (default `./data`; set to a mounted volume in prod)
- `JWT_SECRET`, `AUTH_USERNAME`, `AUTH_PASSWORD` — `/manage` login (defaults are insecure dev values)
- `ADMIN_EMAILS` — comma-separated emails allowed on the admin-only APIs (the flow editor)
- `QBIT_URL`, `QBIT_USERNAME`, `QBIT_PASSWORD` — qBittorrent WebUI for the flow sink node
  (unset ⇒ the "Send to qBittorrent" node errors at run time; dry runs still work)
- `TORRENT_TOSHO_URL`, `TORRENT_TSUKI_URL` — torrent index base URLs (default
  `https://feed.animetosho.xyz` / `https://api.tsukihime.org`)
- `LIBRARY_DIR` — where the **library-import** flow places files (default `/library`);
  point at the Jellyfin media library dir mounted into the pod (see below)
- `JIMAKU_API_KEY`, `JIMAKU_URL` — external subtitle fallback (`enrich.fetch-subs`);
  unset ⇒ that node routes every item to "missed" (the embedded-sub branch still works)
- `NODE_ENV=production` — serve the built `dist/`
- `PORT` — default `3000` (the Dockerfile sets it; the dev backend defaults to `3001`)
- `POSTHOG_KEY` — PostHog project token for portal analytics (public, exposed via `/config.js`;
  unset ⇒ analytics no-op). Events route through `/ingest` reverse proxy on this server.
  Optional `POSTHOG_HOST` (`https://us.i.posthog.com` or EU equivalent — selects proxy region)
  and `POSTHOG_UI_HOST` (defaults from region). In PostHog project settings, set **Authorized URLs**
  to `https://watch.boopurno.es` and `http://localhost:5173`.

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
3. **Bump the version with every change that ships.** Increment `version` in `package.json` (semver:
   patch for fixes, minor for features, major for breaking changes). This is the single source of
   is how a deploy becomes visibly identifiable. One bump per shipped change (if making multiple
   commits for the same continuous feature session/PR, use a patch version for subsequent commits
   rather than repeatedly bumping the minor version).
4. **Open a feature → `dev` PR and wait for the `build` check.** Commit your change (bump included)
   on a short-lived feature branch, push it, and open a PR against `dev` with a **test-plan
   checklist** in the body (`gh pr create --base dev`). Wait for the CI `build` check to pass before
   merging — a red PR never merges. **Never commit directly to `main`, and don't push feature work
   straight to `dev` either** — it reaches `dev` through the PR.
5. **Merge the PR to deploy to staging — merging is not "done".** Merging the PR pushes `dev`, which
   builds `:dev` and rolls `boop-watch-dev`. The merged PR stays the tracking surface for the
   change: **work through its test plan on staging** — wait for the rollout, check the pod is
   `1/1 Running`, smoke-test `/health` + the relevant APIs against the `boop-watch-dev` pod (see
   "Verify a change on staging" above) — and check off each item on the merged PR page (comment the
   results if anything needs noting). Don't consider the change done until every checklist item is
   verified green on staging. If staging surfaces a problem, fix it with a follow-up feature → `dev`
   PR (patch version bump).
6. **Promote to production with a `dev` → `main` PR.** Once the staging checklist is green, open
   `gh pr create --base main --head dev` to ship to prod (`watch.boopurno.es`). **Never commit
   directly to `main`.** Don't leave the tree dirty. If it already had unrelated pending changes,
   call that out rather than bundling them. Remote: `github.com/n0es/boop-watch` (private).
