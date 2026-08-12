# The TV and movie import flows

**Status:** authored and dry-run verified on both environments, 2026-08-08. Both **disabled**.

Flow graphs live in each environment's own `series.sqlite`, not in git, so this file is the only
record of what was built and why. The graphs themselves are in the databases:

| | staging (`boop-watch-dev`) | production (`boop-watch`) |
|---|---|---|
| TV import | flow **#46** | flow **#30** |
| Movie import | flow **#47** | flow **#31** |

The two environments' graphs are byte-identical apart from the qBittorrent category (`tv-dev` vs
`tv`, `movies-dev` vs `movies`) — verified node-by-node and edge-by-edge after replication.

## Shape

The anime "Library import" (#4 on both) is 50 nodes and 64 edges. Almost all of that is anime-
specific: cour→TVDB season mapping, `enrich.anime-status`, the dual-audio scoring and mux, the
donor hunt, the subtitle keep/fetch branch, the Discord notifications. **A TV import needs none of
it**, so these are 12 and 13 nodes:

```
trigger.start ─┐
               ├─→ source.qbittorrent ─→ transform.expand-files ─→ [transform.parse-season] ─→
trigger.qbit-complete ─→ filter.field (category gate) ─┘

  → enrich.indexer-match ─┬─ matched ──→ enrich.metadata ─→ [filter.compare year] ─→
                          └─ unmatched → sink.log                    ↓
                                                     sink.library-import ─→ sink.jellyfin-scan
                                                                       └──→ sink.log
```

`transform.parse-season` is TV-only. The year gate is movies-only (see below).

`section` is set on all four section-aware nodes — `enrich.indexer-match`, `enrich.metadata`,
`sink.library-import`, and implicitly the category on `source.qbittorrent`. That is load-bearing:
each defaults to `anime`, and an unscoped matcher will happily token-match a TV release against an
anime row and file a real video into the wrong library.

## Decisions worth not relitigating

**No `pathTemplate` override on `sink.library-import`.** Left empty so the sink takes the section's
own layout from `sectionConfig()` — `{show} ({production_year})/Season {season:2}/…` for TV, and a
flat `{show} ({production_year})/{show} ({production_year})` for movies, which is what Jellyfin's
movie scanner wants. Overriding it for movies would bury every film a folder deep.

**`overwrite: false`.** The anime flow sets `true` because it has upgrade logic (mux, donor hunt,
score-based `combine.group-pick`) that deliberately replaces a file with a better one. These flows
have none, so an already-present file is left alone.

**`seasonField` is empty on `enrich.indexer-match`.** It restricts candidates to catalog rows whose
`tvdb_season` matches, and `tvdb_season` is only populated by the *anime* cour resolver — TV rows
don't carry it, so setting it would match nothing. `transform.parse-season` still runs on the TV
flow, writing `season` for the path template (`sink.library-import` reads
`tvdb_season ?? tag_season ?? season ?? parent_index_number`).

**The movie flow has an extra year gate, and it is a workaround.** `enrich.indexer-match` cannot
distinguish a sequel from its predecessor: "Iron Man 2"'s release name contains 100% of "Iron Man"'s
distinctive tokens, so it scores 1.0 against the wrong row and *both films resolve to the same
destination path*. Raising `threshold` does not help. A `filter.compare` on
`name contains {production_year}` after `enrich.metadata` routes the mismatch to a log instead of
the library. It fails toward skipping, which is the safe direction, but it also rejects a release
whose name carries no year at all. The real fix is a `yearField` on the node, doing for films what
`seasonField` does for anime cours — **#341**.

## qBittorrent categories

`tv` / `tv-dev` and `movies` / `movies-dev`, mirroring `anime` / `anime-dev` exactly: production
reads the bare name, staging the `-dev` one, so a staging run can never consume production's queue.
All four were created on the shared qBittorrent instance.

Deliberately **not** `sonarr` / `radarr`. Those exist and hold TV and film downloads, but the *arr
stack owns that queue and runs its own import — both would act on the same files — and there is no
`-dev` variant, so staging and production would share one category.

Blank is not a valid way to say "all categories" here, whatever the node's help text claims:
`str(config, 'category', 'anime')` treats an empty string as absent and falls back to **anime**.
A TV flow with a blank category silently reads the anime queue — **#340**.

## Why both are disabled

Nothing has queued into `tv` / `movies` yet and the TV/movie catalogs are empty on production, so an
enabled flow could only no-op — or act on a category someone later creates meaning something else.
Enable when there is content to import:

```bash
node mcp/flows-server.mjs enable 30    # prod TV   (BOOP_API=https://watch.boopurno.es)
node mcp/flows-server.mjs enable 31    # prod movies
```

Each carries a `trigger.qbit-complete` gated on its own category, so once enabled a finished
download is imported promptly; add a `trigger.start` schedule too if you want a periodic sweep
(the anime flow runs every 3h, because files finish after the magnet is queued).

## Verification

Both were dry-run against **real completed torrents** on staging, by labelling four already-finished
uncategorised downloads (Criminal Minds S01 → `tv-dev`; Iron Man, Iron Man 2, The Incredible Hulk →
`movies-dev`). Dry runs write nothing.

```
TV (#46)      qb 1 torrent → exp 22 files → pseason 22/22 → match 22/22 → meta 1 TMDB record
              → imp 22 imported, 0 skipped
              /data/tv-dev/Criminal Minds (2005)/Season 01/Criminal Minds - S01E01.mkv

Movies (#47)  qb 3 torrents → exp 3 files → match 2/3 (The Incredible Hulk not in catalog)
              → yearGate 1 pass / 1 fail → imp 1 imported
              /data/movies-dev/Iron Man (2008)/Iron Man (2008).mp4
              rejected: "Iron man 2 (2010) …" matched Iron Man (2008); not importing
```

The section scoping was checked negatively too: pointed at the anime queue, the TV flow expanded 57
anime files and matched **0** of them against the TV catalog.

Production's dry runs are structurally identical and find 0 torrents, because nothing has been
queued into `tv` / `movies` there yet.
