# Config cutover — moving settings from `link` into the app

**Status:** ready to execute. All code is shipped; this is an operations task.
**Prereqs:** all met — prod is on v2.88.2, staging on v2.89.0, both have a valid `CONFIG_KEY`.

## Why

Settings used to be env vars in `link`, so changing one meant editing the deployment, redeploying,
and waiting for a pod roll — for values this app is the only consumer of. Phases A–D moved the
machinery into the app:

| | |
|---|---|
| A (v2.86.0) | `app_config` table, `CONFIG_SPEC`, `cfg()`, AES-256-GCM secrets under `CONFIG_KEY` |
| B (v2.87.0) | `/manage/settings` + `GET/PUT/DELETE /api/config` |
| C (v2.88.0) | every reader goes through `cfg()`, per-call so edits are live |
| D (v2.89.0) | flows read settings: `{{config.KEY}}` anywhere, plus the `value.config` node |

**Nothing has actually moved yet.** Both environments still read every value from env, because a
present env var wins. This document is that last step.

## The one rule that governs the whole cutover

> **A *present* env var beats the database — even when its value is empty.**
> The test is `key in process.env`, not truthiness.

Consequences, and they are the entire method here:

- Saving a value in `/manage/settings` while the env var still exists **does nothing**. The row is
  stored; it is just shadowed. The settings page marks these rows `env` and says so inline.
- So the order is always: **save → confirm the row reads `database` → remove from `link`.**
- It is reversible. Putting the variable back in `link` re-shadows the DB value instantly.
- **Do not "simplify" this to `??` or `||`.** `preview-env.mjs` and `agent-env.mjs` disable the flow
  sink by injecting *explicit empty* `QBIT_*`/`LIBRARY_DIR` vars while seeding their DB from dev. If
  the database won, every PR preview would inherit dev's real qBittorrent credentials.

## Current state (audited 2026-08-08)

Both environments: **0 settings in the database.** `CONFIG_KEY` valid on both.

### Production — 19 env-owned, 13 on defaults

```
  JELLYFIN_URL                 http://jellyfin.link-apps
S JELLYFIN_API_KEY             <set>
  WATCH_COLLECTION_ID          b74bb14e0d30a021a892c05646ae41cc
  WATCH_COLLECTION_ID_TV       3d5541ad059f915b667ac7150726ea1a
  WATCH_COLLECTION_ID_MOVIES   47daf2306beb45f5c8667dde1d41afba
  LIBRARY_DIR                  /data/anime
S TMDB_API_KEY                 <set>
  JIKAN_URL                    http://jikan-rest.jikan.svc.cluster.local:8080/v4
S FANART_API_KEY               <set>
S JIMAKU_API_KEY               <set>
  JIMAKU_URL                   https://jimaku.cc/api
  QBIT_URL                     http://192.168.50.192:8090
  QBIT_CATEGORY                anime
  POSTHOG_KEY                  phc_wMta34dwcysh4u6EpbEXyxH2ZQTwkvYysJEbCPiiQdB5
  GITHUB_APP_ID                4269249
S GITHUB_APP_PRIVATE_KEY       <set>
  GITHUB_REPO                  boophost/boop-watch
  SCHEDULE_TZ                  America/New_York
  WORK_DIR                     /data/.boop-work
```

### Staging — 21 env-owned, 11 on defaults

Same as prod except: `JELLYFIN_URL=http://jellyfin-dev.link-apps`, `LIBRARY_DIR=/data/anime-dev`,
`QBIT_CATEGORY=anime-dev`, and it additionally has `QBIT_USERNAME=admin` + `QBIT_PASSWORD` set.

### Gaps worth fixing during the cutover, not after

- **Prod has no `QBIT_USERNAME` / `QBIT_PASSWORD`.** It authenticates only via qBittorrent's subnet
  whitelist. That is what made #327 a total outage when the whitelist stopped matching. Setting real
  credentials removes the single point of failure.
- ~~`LIBRARY_DIR_TV` / `LIBRARY_DIR_MOVIES` are unset everywhere~~ — **done 2026-08-08**, and they
  are the first two values to live in the database rather than in `link`. See "Library layout" below.
- **Prod and staging share one `CONFIG_KEY`** (fingerprint `f0a27b5e6f8f`). Works, but the
  environments are not cryptographically isolated — a leaked dev key decrypts prod's secrets.
  Rotating prod to its own key is a good idea; see "Rotating CONFIG_KEY" below.

## Method

Work **staging first, then production**, one group at a time. Never batch a group across both.

For each setting:

1. **Save it** at `/manage/settings` (or `PUT /api/config/:key`). It will still show `env`.
2. **Remove it from `link`**'s app config for that deployment.
3. **Redeploy / let the pod roll.**
4. **Confirm the row now reads `database`** and the value is right.
5. **Exercise the thing it controls** (see per-group checks below).

Roll back by putting the variable back in `link` — the DB row stays and is simply re-shadowed again.

### Order of groups — least blast radius first

**Group 1 — inert URLs and identifiers.** `GITHUB_REPO`, `SCHEDULE_TZ`, `JIMAKU_URL`, `JIKAN_URL`,
`QBIT_CATEGORY`, `GITHUB_APP_ID`, `POSTHOG_KEY`.
*Check:* `/api/config` shows `database`; the schedule page still renders; a suggestion still files an
issue; the Activity page still shows the `jikan` queue serving requests.

**Group 2 — paths.** `LIBRARY_DIR`, `WORK_DIR`, and **set** `LIBRARY_DIR_TV` / `LIBRARY_DIR_MOVIES`.
*Check:* `/api/sections` shows the right `libraryRoot` per section and `jellyfinMatch: "path"` where
a Jellyfin library exists; a library-import **dry run** still reports 116 nodes, 0 errors, and its
`sink.library-import` node still targets the same destination path.
⚠️ `WORK_DIR` is the #200 hazard — if it ends up on the node PVC instead of the media NFS,
`assertScratchVolumeSafe` should refuse to start. That guard firing is a *pass*, not a failure.

**Group 3 — Jellyfin.** `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `WATCH_COLLECTION_ID*`.
*Check:* **do this one carefully — it gates the public portal.** `/api/catalog` returns items and all
three sections; `/img/:id` returns 200; a `master.m3u8` still plays; `jellyfinReachable: true`.

**Group 4 — third-party credentials.** `TMDB_API_KEY`, `FANART_API_KEY`, `JIMAKU_API_KEY`,
`GITHUB_APP_PRIVATE_KEY`.
*Check:* a TV search returns real TMDB hits; the `tmdb` queue on Activity shows 200s and
`retried: 0`; `GET /api/config` **never** contains a secret value (grep the raw JSON).

**Group 5 — qBittorrent.** `QBIT_URL`, and **set** `QBIT_USERNAME` / `QBIT_PASSWORD` (new on prod).
*Check:* `/api/series/:id/downloads` shows `qbitError: null`; the import dry run gets past
`source.qbittorrent`; qBittorrent's log accumulates **no** `WebAPI login failure` lines.
⚠️ Failed logins ban the shared SNAT address (`10.42.0.0`) and lock out *every* client including your
browser. Get the credentials right before the pod retries. See #330 — the retry guards are not built
yet, so a wrong value here is still self-amplifying.

### What must stay in `link` — do not move these

`DATA_DIR`, `DATABASE_PATH`, `PORT`, `NODE_ENV`, `JWT_SECRET`, `SUPABASE_*`, `CONFIG_KEY` — each is
needed before the database, or before the login guarding the settings page, exists. They are
deliberately absent from `CONFIG_SPEC`. Also `ADMIN_EMAILS` / `AUTH_*` (they gate the page that edits
everything else — a lockout risk) and `SCHEDULER_ENABLED` (a kill switch must not depend on the app
being healthy).

## Verification helpers

**`scripts/config-audit.cjs`** prints the table above for whichever pod it runs in — it mints a JWT
from the pod's own `JWT_SECRET`, calls `/api/config`, and groups every key by source. Secrets are
reported as `<set>` / `<EMPTY>`, never by value. Run it before and after each group:

```bash
kubectl -n link-apps exec -i deploy/boop-watch-dev -- \
  sh -c 'cat > /tmp/a.cjs && node /tmp/a.cjs' < scripts/config-audit.cjs
# ...and the same with deploy/boop-watch for production
```

Per-group smoke commands:

```bash
# sources at a glance
GET /api/config            -> every key with source env|database|default
# sections + Jellyfin cross-check
GET /api/sections          -> libraryRoot, jellyfinMatch, providerConfigured
# the full pipeline, writes nothing
POST /api/flows/<id>/run  {"dryRun": true}
# public portal
curl https://watch.boopurno.es/health
curl https://watch.boopurno.es/api/catalog
```

## Rotating `CONFIG_KEY` (optional, recommended for prod)

Because both environments share one key today. Rotation is safe but ordered:

1. Note which secrets are stored in `app_config` (`GET /api/config`, rows with `source: database`).
2. Generate a new key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
3. Set it in **link's app config** (not `kubectl set env` — #224 means a live-set var is reverted).
4. Redeploy. Every stored secret now reports a decrypt error on its settings row, naming the key —
   this is the designed behaviour, not a bug.
5. Re-enter each secret through the page. Rows go green again.

Losing the key without re-entering means every stored secret is unrecoverable. Keep a copy.

## Done when

- `GET /api/config` on **both** environments shows `database` for every migrated key and `env` only
  for the bootstrap set.
- `link`'s app config for both deployments contains only the bootstrap variables.
- A library-import dry run on both is `ok: true`, 116 nodes, 0 errors.
- The public portal serves normally, and `/manage/settings` shows no decrypt errors.
- Changing a value on the page takes effect **without a redeploy** — demonstrate it once, because
  that is the entire point of the exercise.


## Library layout (settled 2026-08-08)

Each section has **its own Jellyfin library**. Confirmed against both servers, and the section
collections were checked by *membership*, not by name — dev’s are labelled oddly ("TV Broadcast
Prohibited", "Motu Patlu Movies") but contain exactly the right titles, so the labels are cosmetic.

| | prod library | prod path | staging library | staging path |
|---|---|---|---|---|
| anime | `Anime` (tvshows) | `/data/anime` | `Shows` (tvshows) | `/data/anime-dev` |
| tv | `Shows` (tvshows) | `/data/tv` | *(none yet)* | `/data/tv-dev` |
| movies | `Movies` (movies) | `/data/movies` | `Movies` (movies) | `/data/movies-dev` |

Prod also has an **`Anime Movies`** library at `/data/anime-movies`, which no section maps to today.

`LIBRARY_DIR_TV` and `LIBRARY_DIR_MOVIES` are now set **in the database** on both environments, and
`/api/sections` matches all three prod sections to a real library by `basis: "path"`.

**Staging shares the same media NFS as production.** `/data/tv` and `/data/movies` are visible from
the staging pod, so pointing staging at them would make a staging import write into production’s
library. Staging therefore uses the `-dev` convention throughout; `/data/tv-dev` was created for
this (it did not exist), mirroring `anime-dev` and `movies-dev`.

**Outstanding:** staging’s Jellyfin has no library pointing at `/data/tv-dev`, so `/api/sections`
reports `jellyfin: null` for its TV section and Jellyfin will not serve anything imported there.
Add one (type: Shows) before testing a TV import end to end on staging. Prod needs nothing.

Verified after the change: prod’s anime import dry run is unchanged (still resolves
`mal 59970 → tvdb 352408 S4`, matches an indexer title, expands a file), and the public portal
serves 37 items across all three sections.