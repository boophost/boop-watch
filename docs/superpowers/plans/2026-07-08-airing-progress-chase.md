# Airing Progress & Next-Episode Chase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch-up checkmarks for airing seasons plus a next-episode chase on admin and public surfaces.

**Architecture:** Pure chase resolver in `server/episodeChase.ts` (aired dates + torrents + library + on-site → `EpisodeChase`). Admin and public APIs call it; React renders strip/panel/chips and a shared public `EpisodeStatus` (icon + label).

**Tech Stack:** Express/TS backend, React/Vite SPA, existing Jikan episode cache, qBit/portal maps. No new test runner — verify with `npm run build:all` + a small `node --experimental-strip-types` smoke on the pure helper.

---

## File map

| File | Role |
|------|------|
| `server/episodeChase.ts` | Pure types + `resolveExpected`, `resolveNextChase`, label helpers |
| `server/downloads.ts` | Export `parseEpisode` if needed; optional thin wrappers |
| `server/index.ts` | Enrich detail/downloads + list with chase fields |
| `server/publicRoutes.ts` | Catalog/watch `nextEpisode` + stub episode |
| `server/watch.ts` | Accept optional upcoming stub in sibling list |
| `src/lib/chase.ts` | Shared client types + public/admin label formatters |
| `src/components/EpisodeStatus.tsx` | Public icon+label status |
| `src/components/Icon.tsx` | Add `download`, `spinner` icons |
| `src/kagura.css` | Status animations + reduced-motion |
| `src/pages/SeriesDetail.tsx` | Airing denominator + chase panel |
| `src/components/SeriesList.tsx` | Chase chip |
| `src/pages/Title.tsx` | Badge + upcoming row |
| `src/pages/Watch.tsx` | Upcoming sidebar row |
| `src/lib/api.ts` | Extend public types |
| `package.json` | Minor version bump |
| `scripts/verify-episode-chase.mjs` | Smoke tests for pure resolver |

---

### Task 1: Chase resolver (pure)

**Files:**
- Create: `server/episodeChase.ts`
- Create: `scripts/verify-episode-chase.mjs`

- [ ] **Step 1: Implement resolver**

```ts
// server/episodeChase.ts
export type ChaseState = 'waiting' | 'searching' | 'downloading' | 'importing' | 'ready'

export interface EpisodeAirInfo {
  episode: number
  title?: string | null
  aired?: string | null
}

export interface EpisodeChase {
  episode: number
  title?: string | null
  airsAt: string | null
  state: ChaseState
  progress?: number | null
}

export function resolveExpected(
  malEpisodes: number | null | undefined,
  aired: EpisodeAirInfo[],
  now = Date.now(),
): { airedCount: number; expected: number | null } {
  const airedCount = aired.filter((e) => {
    if (!e.aired) return false
    const t = Date.parse(e.aired)
    return Number.isFinite(t) && t <= now
  }).length
  if (airedCount > 0) return { airedCount, expected: airedCount }
  if (malEpisodes && malEpisodes > 0) return { airedCount: 0, expected: malEpisodes }
  return { airedCount: 0, expected: null }
}

export function resolveNextChase(args: {
  episodes: EpisodeAirInfo[]
  siteEpisodes: Record<string, string>
  libraryEpisodes: Set<number>
  torrents: Array<{ episode: number | null; progress: number; isBatch?: boolean }>
  now?: number
}): EpisodeChase | null {
  const now = args.now ?? Date.now()
  const onSite = (n: number) => !!args.siteEpisodes[String(n)]
  const candidates = [...args.episodes].sort((a, b) => a.episode - b.episode)

  // Prefer lowest not-on-site that has aired (or unknown air after last on-site)
  let next =
    candidates.find((e) => !onSite(e.episode) && e.aired && Date.parse(e.aired) <= now) ??
    candidates.find((e) => !onSite(e.episode) && e.aired && Date.parse(e.aired) > now) ??
    null

  if (!next) {
    // Fallback: next integer after max on-site if we have any gap signal from torrents/library
    const siteNums = Object.keys(args.siteEpisodes).map(Number).filter(Number.isFinite)
    const maxSite = siteNums.length ? Math.max(...siteNums) : 0
    const guess = maxSite + 1
    if (guess < 1) return null
    const hasSignal =
      args.libraryEpisodes.has(guess) ||
      args.torrents.some((t) => t.episode === guess || (t.isBatch && t.progress < 1))
    if (!hasSignal && !candidates.length) return null
    next = candidates.find((e) => e.episode === guess) ?? { episode: guess, title: null, aired: null }
    if (onSite(next.episode)) return null
  }

  if (onSite(next.episode)) return null

  const airsAt = next.aired ?? null
  const airMs = airsAt ? Date.parse(airsAt) : NaN
  const future = Number.isFinite(airMs) && airMs > now

  const epTorrents = args.torrents.filter(
    (t) => t.episode === next!.episode || (t.isBatch && t.episode == null),
  )
  const active = epTorrents.filter((t) => t.progress < 1)
  const complete = epTorrents.filter((t) => t.progress >= 1)
  const inLib = args.libraryEpisodes.has(next.episode)

  let state: ChaseState
  let progress: number | null = null
  if (future) state = 'waiting'
  else if (active.length) {
    state = 'downloading'
    progress = Math.max(...active.map((t) => t.progress))
  } else if (complete.length || inLib) state = 'importing'
  else state = 'searching'

  return {
    episode: next.episode,
    title: next.title ?? null,
    airsAt,
    state,
    progress,
  }
}

/** Public-safe copy of chase (no progress). Omit when ready. */
export function toPublicChase(c: EpisodeChase | null): Omit<EpisodeChase, 'progress'> | null {
  if (!c || c.state === 'ready') return null
  return { episode: c.episode, title: c.title, airsAt: c.airsAt, state: c.state }
}
```

- [ ] **Step 2: Smoke script**

```js
// scripts/verify-episode-chase.mjs — import compiled or use dynamic import after build:server
// Assert: 1 aired + on site → expected=1; next chase = ep 2 waiting
// Assert: past air + no torrent → searching
// Assert: torrent 0.4 → downloading
// Assert: complete torrent not on site → importing
```

Run after Task 1 is wired: `node scripts/verify-episode-chase.mjs` (script may `tsx` import `server/episodeChase.ts`).

- [ ] **Step 3: Commit** `feat: add episode chase resolver`

---

### Task 2: Wire chase into admin APIs

**Files:**
- Modify: `server/index.ts` (detail, downloads, list)
- Modify: `server/downloads.ts` if exporting helpers

- [ ] **Step 1: Enrich `GET /api/series/:id/downloads`**

After `getSeriesDownloadStatus` + library fetch (or inside a new `getSeriesChaseContext(seriesId)`):

```ts
const cached = series.mal_id ? getCachedEpisodes(series.mal_id) : []
const airInfos = cached.map((e) => ({ episode: e.number, title: e.title, aired: e.aired }))
const { airedCount, expected } = resolveExpected(series.episodes, airInfos)
const lib = await getSeriesLibraryMedia(seriesId)
const libraryEpisodes = new Set(lib.map((e) => e.episode).filter((n): n is number => n != null))
const nextChase = resolveNextChase({
  episodes: airInfos,
  siteEpisodes: status.siteEpisodes,
  libraryEpisodes,
  torrents: status.torrents,
})
res.json({ ...status, blacklist, airedCount, expectedForPipeline: expected, nextChase })
```

- [ ] **Step 2: List enrichment for chips**

In `GET /api/series`: after `listSeries()`, batch once:
- `getAllPortalItems()` → build per-series site maps (reuse title overlap from downloads or a shared helper)
- optional single `qbitList()` if configured
- per series with `getCachedEpisodes`: `resolveNextChase` (library set empty or skip importing precision on list — prefer torrent+site only for list chips to stay cheap; detail page has full accuracy)

Spec allows skipping when no episode cache. Prefer **cheap list**: aired + site + torrents only (no per-series Jellyfin library call). `importing` on list only when torrent complete and not on site.

- [ ] **Step 3: Commit** `feat: expose nextChase on admin series APIs`

---

### Task 3: Admin UI — strip + chase panel + list chip

**Files:**
- Modify: `src/pages/SeriesDetail.tsx`
- Modify: `src/components/SeriesList.tsx`
- Create: `src/lib/chase.ts` (formatCountdown, chaseChipLabel)

- [ ] **Step 1: `pipelineStages` uses `expectedForPipeline` from downloads response**

```ts
expected={dl?.expectedForPipeline ?? mal?.episodes ?? series.episodes ?? null}
```

- [ ] **Step 2: `EpisodeChasePanel` under strip**

Render when `dl?.nextChase` and state !== ready. Mini steps: Waiting | Download | Library | On site mapped from state.

- [ ] **Step 3: SeriesList chip** from `s.nextChase`

- [ ] **Step 4: Commit** `feat: admin chase panel and list chips`

---

### Task 4: Public API

**Files:**
- Modify: `server/publicRoutes.ts`
- Modify: `server/watch.ts` / watch route
- Modify: `src/lib/api.ts`

- [ ] **Step 1: Catalog series detail**

When `manageId` / mal_id known: load cached episodes + download status (or lighter site+torrent), `resolveNextChase`, attach:

```ts
nextEpisode: toPublicChase(chase)
// append stub if chase:
episodes: [...playable, { id: null, name: chase.title ?? `Episode ${chase.episode}`, num: formatNum(chase.episode), status: chase.state, airsAt: chase.airsAt }]
```

- [ ] **Step 2: Watch payload**

Add `nextEpisode: toPublicChase(...)` top-level; sidebar merges stub after siblings.

- [ ] **Step 3: Commit** `feat: public nextEpisode on catalog and watch`

---

### Task 5: Public UI — EpisodeStatus + Title + Watch

**Files:**
- Create: `src/components/EpisodeStatus.tsx`
- Modify: `src/components/Icon.tsx` (`download`, `spinner`)
- Modify: `src/kagura.css`
- Modify: `src/pages/Title.tsx`
- Modify: `src/pages/Watch.tsx`

- [ ] **Step 1: Icons + CSS animations** (`ep-status-pulse`, `ep-status-radar`, `ep-status-bounce`, `ep-status-spin`) with `@media (prefers-reduced-motion: reduce)`.

- [ ] **Step 2: `EpisodeStatus`** — icon + label for waiting/searching/downloading/importing.

- [ ] **Step 3: Title badge + non-link row; Watch non-link row.**

- [ ] **Step 4: Commit** `feat: public episode status icons and rows`

---

### Task 6: Version + verify

- [ ] Bump `package.json` to `2.44.0`
- [ ] `npm run build:all`
- [ ] `node scripts/verify-episode-chase.mjs`
- [ ] Commit `chore: bump to 2.44.0 for airing chase`

---

## Spec coverage

| Requirement | Task |
|-------------|------|
| Airing-aware denominator (aired-first) | 1, 3 |
| Strip stays green; chase underneath | 3 |
| Admin chase panel | 3 |
| Admin list chip | 2, 3 |
| Public /series + /watch | 4, 5 |
| searching → downloading → almost ready | 1, 5 |
| Animated icons + reduced motion | 5 |
| No new scrapers | all |
| build:all | 6 |
