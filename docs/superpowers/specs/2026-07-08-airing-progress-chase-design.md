# Airing Progress & Next-Episode Chase Design Spec

**Date:** 2026-07-08  
**Status:** Approved  
**Goal:** Make currently-airing seasons show as caught-up (checkmarks) when all aired episodes are imported/on-site, and surface a next-episode chase — with countdown before air and soft pipeline status after — on admin and public surfaces.

---

## Background

The admin series detail page (`/manage/series/:id`) shows a four-stage pipeline strip: Catalog → Download → Library → On site. Library and On site are “done” only when counts reach `expected` (MAL/`series.episodes` total). For currently-airing seasons that total is often `null` or far ahead of what’s aired, so a show with 1/1 aired episodes stays on blue spinners forever.

Jikan already provides per-episode `aired` dates on the episodes API. Download/library/on-site maps already exist for the manage page. The public portal (`/series/:id`, `/watch/:id`) only lists playable Jellyfin episodes — viewers get no signal that another episode is coming or landing.

---

## Requirements

### Functional

1. **Airing-aware denominator** — Pipeline “done” for Library/On site measures **broadcast catch-up**, not season completion:
   - Prefer `airedCount` (episodes with `aired <= now`) when &gt; 0 — so 1 aired / 1 imported shows checkmarks while the cour continues
   - Fall back to MAL/`series.episodes` when aired dates are unknown
   - Season-vs-MAL completion is **not** a second meter in v1 (chase panel covers the remaining eps)
2. **Strip stays green when caught up** — When lib/on-site counts meet the airing-aware denominator, stages show checkmarks. They do **not** flip back to spinners when a newer episode airs; that chase lives under the strip.
3. **Next-episode chase panel (admin)** — Under the strip on series detail: episode number, air timing, and a mini pipeline (Waiting → Download → Library → On site) for that next episode only. After air, show searching / downloading (with %) / importing as appropriate.
4. **Admin list chip** — `/manage` series list shows a compact chase chip (`Ep N · 5d 14h`, `Ep N · downloading`, etc.).
5. **Public `/series/:id`** — Badge + episode-list row for the next chase episode with icon + label (treatment C).
6. **Public `/watch` episode sidebar** — Same icon + label status for the next chase episode; row is non-playable until ready.
7. **Public post-air labels** — After air date, viewers see: `searching` → `downloading` → `almost ready` → playable. Before air: countdown / air date.
8. **Animated icons** — Public (and admin chase where useful) use animated icons: calendar pulse (waiting), search radar (searching), download bounce (downloading), spinner (almost ready / importing).

### Non-functional

- Reuse existing Jikan aired dates + download/library/site signals; no new scrapers or TsukiHime wiring in v1.
- Additive API fields only; don’t break existing clients.
- Public copy stays viewer-friendly (no qBit %, no “import” jargon — use “almost ready”).
- Respect `prefers-reduced-motion` (static icons when reduced motion is set).

### Out of scope

- Changing acquisition/library-import flow logic
- Schedule page redesign
- Showing chase for every future episode (only the single next chase target)
- Exposing torrent names or indexer details publicly

---

## State machine

Shared enum `ChaseState`:

| State | Condition | Public label | Admin chase detail |
|---|---|---|---|
| `waiting` | Next ep has `airsAt > now` | countdown / air date | Waiting for release |
| `searching` | Past air; no matching torrent; not in library; not on site | searching | Searching for release |
| `downloading` | Matching torrent with `progress < 1` | downloading | Downloading N% |
| `importing` | Torrent complete and/or in library, not yet on site | almost ready | Importing / not on site yet |
| `ready` | Episode id present in on-site map | (playable row) | Chase advances or hides |

**Next episode selection**

1. Prefer lowest episode number that is past air (or has unknown air but is the next missing after last on-site) and not yet on site.
2. Else soonest future-aired episode not on site.
3. If none → no chase panel / no public upcoming row.

**Denominator (catch-up)**

```
airedCount = count(episodes where aired != null && aired <= now)
expected = (airedCount > 0) ? airedCount : (malEpisodes > 0 ? malEpisodes : null)
```

Library/On site `done` when `count >= expected && expected > 0`.  
Rationale: MAL total while airing would keep spinners up for the whole cour; catch-up vs broadcast matches the product intent.

---

## Data & API

### Shared types (server + client)

```ts
type ChaseState = 'waiting' | 'searching' | 'downloading' | 'importing' | 'ready'

interface EpisodeChase {
  episode: number
  title?: string | null
  airsAt: string | null       // ISO; null if unknown
  state: ChaseState
  progress?: number | null    // 0..1 when downloading (admin may show %)
}
```

### Admin

- Extend series detail / downloads assembly (or detail payload) with:
  - `airedCount: number`
  - `expectedForPipeline: number | null`  // resolved denominator
  - `nextChase: EpisodeChase | null`
- Extend `GET /api/series` list entries with optional `nextChase` (and maybe `caughtUp: boolean`) for list chips. Compute cheaply from cached episode air dates + existing download/site maps; if too expensive, compute chase only when episode cache exists and skip otherwise.

### Public

- `GET /api/catalog/:id` (series): include
  - `nextEpisode: EpisodeChase | null` (never `ready` — omit when playable)
  - optional stub in `episodes` list: `{ id: null, num, name, status: ChaseState, airsAt }` for the chasing ep so the list can render a non-link row
- Watch payload (`GET /api/watch/:id`): sibling list may include the same upcoming stub after the last playable ep (or a top-level `nextEpisode`). Prefer one consistent shape with catalog detail.

Public endpoints must **not** expose torrent names, qBit errors, or raw paths — only `state`, `episode`, `airsAt`, optional coarse `progress` omitted publicly (label only).

---

## UI

### Admin — `PipelineStrip`

- Pass `expectedForPipeline` instead of raw MAL total.
- Details like `1/1 imported` when denominator is aired-so-far.

### Admin — `EpisodeChasePanel` (new)

- Below strip on `SeriesDetail`.
- Header: `Next episode · Ep N` + timing (`airs Fri · 5d 14h` or `aired 2h ago`).
- Mini steps with current step highlighted; downloading shows percent.

### Admin — `SeriesList` chip

- Compact chip using same state → label mapping (may include % for downloading).

### Public — `EpisodeStatus` (new shared component)

- Icon + label everywhere (treatment C).
- Icons added to portal `Icon` map (or a small dedicated status icon set): `calendar`, `search` (existing), new `download`, reuse/add spinner.
- CSS animations in `kagura.css`, gated by `prefers-reduced-motion`.

### Public — `Title` (`/series/:id`)

- Badge near series badges when `nextEpisode` present.
- Episode list: playable rows unchanged; append/include chasing row as non-`Link` with `EpisodeStatus`.

### Public — `Watch` sidebar

- Same non-playable chasing row + `EpisodeStatus`.
- Do not auto-advance into a chasing stub.

---

## Implementation notes

- Centralize chase resolution in one server helper (e.g. `server/episodeChase.ts`) used by admin downloads/detail and public catalog/watch builders.
- Prefer Jikan/cached `series_episodes.aired` for air dates; don’t block the page if Jikan is down — degrade to no chase / strip uses MAL total only.
- Matching torrents to episode number: reuse existing `parseEpisode` / per-torrent `episode` on `SeriesDownload`.
- “In library but not on site” ⇒ `importing` (public: almost ready).
- Version bump (minor) when shipping.

---

## Testing / verification

1. Airing series with 1 aired ep, 1 in library + on site, MAL total null or 12 → strip all checkmarks; chase shows next ep waiting or searching.
2. After air date with no torrent → public + admin `searching`.
3. Active torrent for that ep → `downloading` (admin shows %; public does not).
4. Complete torrent / library file, not in Public collection → `importing` / `almost ready`.
5. On site → chase clears; episode row becomes playable.
6. Finished series (all expected on site) → no chase panel.
7. `prefers-reduced-motion`: icons static.
8. `npm run build:all` green.

---

## Rollout

Feature branch → PR to `dev` with test-plan checklist → merge → verify on `boop-watch-dev` → later `dev` → `main`.
