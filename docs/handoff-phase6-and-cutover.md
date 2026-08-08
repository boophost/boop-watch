# Handoff — finish sections Phase 6, then the config cutover

Paste the prompt below into a fresh Claude Code session in this repo. Everything it references is
either committed here or reachable with the tools listed.

---

## THE PROMPT

> Two jobs, in this order: **author the TV and movie library-import flows**, then **run the config
> cutover**. Both are operations work — the code is already shipped and on staging.
>
> Read `docs/config-cutover-plan.md` first; it is the runbook for job 2 and it documents the library
> layout both jobs depend on. Read the "The catalog is sectioned" and "Configuration lives in the DB"
> sections of `CLAUDE.md` before touching anything.
>
> ### Job 1 — TV and movie import flows
>
> The code half is done (v2.92.0): `enrich.indexer-match`, `enrich.metadata`, `source.jellyfin` and
> `sink.library-import` all take a `section` config that defaults to `anime`. What does not exist is
> the **flow graphs** for TV and movies. Flow graphs live in each environment's own `series.sqlite`,
> not in git, so they are authored on staging and then hand-replicated to production.
>
> Model them on the existing **"Library import"** flow (`#4` on *both* environments — 50 nodes, 64
> edges). Do not copy it wholesale. Most of it is anime-specific and should be dropped: the
> `enrich.anime-status` node, the season/cour handling (`transform.parse-season`, the episode-offset
> logic), the subtitle branch (`enrich.extract-subs` / `enrich.fetch-subs` / `filter.compare` on
> `sub_langs`), and the `enrich.mux-tracks` / `trimAudio` subflow. A TV import is much shorter:
> source completed torrents → expand to files → match the catalog → enrich metadata → import →
> Jellyfin scan.
>
> Set `section` on every one of the four nodes. A movie flow additionally needs no season handling at
> all — `sink.library-import` already picks the flat `{show} ({production_year})/{show} ({production_year})`
> layout from the section, so do not override `pathTemplate` unless you have a reason.
>
> **Drive flows with the `mcp/` CLI** (`node mcp/flows-server.mjs`, see `mcp/README.md`); it reads
> `mcp/flows.env`, which currently points at **production** — check and change it before writing
> anything. Two API traps: `POST /api/flows` creates an **empty** flow, so the graph must be `PUT`
> separately; and the port type system will reject a bad wire at validation time with a clear message
> (a `text` output into an `items` input, for instance), which is a feature — read the error.
>
> **Always dry-run before trusting it** (`run <id>` without `--live`). A dry run against real queued
> torrents exercises the real matching and ffprobe against live data while writing nothing.
>
> Replicating to production: follow the "Manual replication recipe" in `CLAUDE.md`. Fetch prod's
> current graph fresh and diff node-by-node — the environments have drifted before, and copying
> wholesale silently clobbers prod-only config.
>
> ### Job 2 — the config cutover
>
> `docs/config-cutover-plan.md` is the runbook: five groups, least blast radius first, with the check
> that proves each one. `scripts/config-audit.cjs` prints every setting and its source from inside a
> pod — run it before and after each group.
>
> The rule that governs all of it: **a present env var beats the database, even when empty.** So the
> order is always save → confirm the row reads `database` → remove from `link`. Saving while the env
> var still exists does nothing.
>
> `LIBRARY_DIR_TV` and `LIBRARY_DIR_MOVIES` are already migrated on both environments — the only two
> settings currently living in the database. Everything else is still env-owned.
>
> ### How to work
>
> Verify against the real environments rather than reasoning about them. `kubectl` is configured
> (context `boopurnoes`, namespace `link-apps`); `kubectl exec` a script into a pod, or
> `port-forward` and drive the UI in a browser. **Set `MSYS_NO_PATHCONV=1`** for any command passing
> a `/path` to a Windows exe — Git Bash silently rewrites them and wait-loops then fail closed.
>
> Ship each change as a feature → `dev` PR with a test plan, wait for CI, merge, verify on staging,
> tick the boxes. Do not tick anything you have not actually seen pass. Production is on **v2.88.2**
> and `dev` is at **v2.92.3** — a `dev → main` promotion is due and would be a sensible first step,
> since it puts the section UI and the settings page on prod where job 2 needs them.

---

## Reference — state as of 2026-08-08

### Versions

| | |
|---|---|
| production | v2.88.2 (six commits behind `dev`) |
| staging | v2.92.3 |

### Jellyfin libraries — settled, one per section, both environments mirror

| section | prod library / path | staging library / path |
|---|---|---|
| anime | `Anime` → `/data/anime` | `Anime` → `/data/anime-dev` |
| tv | `Shows` → `/data/tv` | `Shows` → `/data/tv-dev` |
| movies | `Movies` → `/data/movies` | `Movies` → `/data/movies-dev` |

All six report `jellyfinMatch: "path"`. Prod additionally has an **`Anime Movies`** library at
`/data/anime-movies` that no section maps to — decide whether anime films should route there.

**Staging shares the same media NFS as production.** `/data/tv` and `/data/movies` are visible from
the staging pod; pointing staging at them would make a staging import write into prod's library.
Staging uses `-dev` paths throughout.

### Flows (ids differ per environment — never assume they match)

- staging: `#4` Library import, `#40` Show added, `#41` Release aired, `#42` Chase wants, `#37` Trim audio tracks
- prod: `#4` Library import, `#27` Show added, `#28` Release aired, `#29` Chase wants, `#26` Trim audio tracks

### Known-good baselines to compare against

- Library-import **dry run** on either environment: `ok: true`, **116 nodes, 0 errors**. Prod resolves
  real metadata (`mal 59970 → tvdb 352408 S4`), staging usually has an empty queue.
- Public portal: `https://watch.boopurno.es/api/catalog` → 37 items, three sections.

### Open issues worth knowing

- **#330** — qBittorrent retry guards. The ban backoff shipped (v2.89.2); the "don't log in with
  empty credentials" half was **deliberately not implemented**, because prod has no qBittorrent
  credentials and the subnet whitelist is its only way in. There is a comment in `qbit.ts` saying so.
- Prod still has **no** `QBIT_USERNAME`/`QBIT_PASSWORD`. Group 5 of the cutover is the moment to fix
  that. Get it right first time: failed logins ban the shared SNAT address (`10.42.0.0`) and lock out
  every client including your browser.
- Both environments share one `CONFIG_KEY` (fingerprint `f0a27b5e6f8f`). Rotation procedure is in the
  cutover plan.

### Traps that have already cost time in this project

- **Git Bash path mangling** — `MSYS_NO_PATHCONV=1`, or `/app/package.json` becomes
  `C:/Program Files/Git/app/package.json` and a wait-loop burns its whole timeout.
- **`POST /api/flows` creates an empty flow** — `PUT` the graph separately.
- **qBittorrent rewrites its own config on shutdown**, discarding edits made while running. Scale to
  0, edit from a throwaway pod on the same PVC, scale back.
- **Never dump a Secret's annotations** — `last-applied-configuration` contains base64 of every value
  in it. Print fingerprints, not values.
- **The qa-agent can pass an item it did not really verify.** Read its evidence column, not just the
  tick; it has cited the wrong endpoint before.
