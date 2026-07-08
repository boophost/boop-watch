# Plan: unified outbound-request limiter (`server/httpQueue.ts`)

## Problem this solves

Every external service we call reinvents rate-limiting, inconsistently — and the
Jikan protection is already half-broken because two call sites throttle it
independently and don't coordinate.

Current state of outbound throttling:

| Service | Call site(s) | Throttling today |
|---|---|---|
| **Jikan / MAL** | `jikan.ts` | global gate (400 ms) + 429 retry (2 s × attempt) |
| Jikan again | `sync.ts` | separate ad-hoc `setTimeout` 400 ms **and** 1000 ms |
| Jikan again | `flowNodes.ts` enrich nodes | ad-hoc 1000 ms/item |
| **Jikan again** | `aniskip.ts` chain-walk | its **own** `JIKAN_GAP_MS = 350` gate — bypasses `jikan.ts` entirely |
| TsukiHime / Tosho | `flowNodes.ts` `fetchJson` | 429 + **Retry-After** (the good impl) + 1300/500 ms/page |
| AniList | `anilist.ts` (+ `sync.ts`) | none / 300 ms after |
| Kitsu | `banners.ts` | none |
| Jimaku | `flowNodes.ts` `fetchSubs` | 500 ms/item |
| aniskip.com | `aniskip.ts` | none beyond a 5 s timeout |

Two concrete problems, not just aesthetics:

1. **The Jikan gate isn't global.** `jikan.ts`'s serialization promise and
   `aniskip.ts`'s `JIKAN_GAP_MS` are separate module-level gates. When a
   sequel-chain walk (AniSkip) runs while the /manage page or a flow also hits
   Jikan, the two race and can burst past ~3 req/s → 429. Because Cloudflare
   fronts us, a 429 comes back as a **plain-text 502 the SPA can't `JSON.parse`**.
2. **The good logic (Retry-After honoring) lives in exactly one place**
   (`fetchJson`), so AniList / Kitsu / Jimaku / Jikan don't benefit from it.

## The idea: one per-host limiter, not a "queue system"

A shared module that limits outbound calls **per service key** — min-gap
spacing + max concurrency + Retry-After-aware retry + timeout — and every
external fetch routes through it. This is deliberately a **~120-line in-process
limiter**, not a distributed/persistent/priority queue: this is a single-admin
media server whose flows already run one-at-a-time behind a lock, so there is no
scheduling/persistence problem to solve. (See "Scope / non-goals".)

## The module: `server/httpQueue.ts`

```ts
export type ServiceKey =
  | 'jikan' | 'tsukihime' | 'tosho' | 'anilist' | 'kitsu' | 'jimaku' | 'aniskip'

interface ServiceConfig {
  minGapMs: number     // minimum spacing between starts on this key
  concurrency: number  // max simultaneous in-flight on this key
  timeoutMs: number    // per-request AbortSignal timeout
  retries: number      // extra attempts on 429/503 (0 = try once)
}

// The primitive: run any async fn under a key's limiter (min-gap + concurrency).
export function enqueue<T>(key: ServiceKey, fn: () => Promise<T>): Promise<T>

// Fetch through the limiter, with timeout + 429/503 Retry-After retry. Raw Response.
export function limitedFetch(key: ServiceKey, url: string | URL, init?: RequestInit): Promise<Response>

// limitedFetch + res.ok check + res.json(). The common path.
export function limitedJson<T>(key: ServiceKey, url: string | URL, init?: RequestInit): Promise<T>

// Optional: snapshot for a health/debug surface.
export function queueStats(): Record<ServiceKey, { inFlight: number; queued: number; lastErrorAt: number | null }>
```

### Per-service config (starting values, all env-overridable via one JSON or per-key envs)

| key | minGapMs | concurrency | timeoutMs | retries | rationale |
|---|---|---|---|---|---|
| `jikan` | 400 | 1 | 10 000 | 3 | ~3 req/s, must serialize (Cloudflare 429→502) |
| `tsukihime` | 1300 | 1 | 20 000 | 3 | documented per-IP window (50/min on search) |
| `tosho` | 500 | 1 | 20 000 | 3 | undocumented; stay polite |
| `anilist` | 350 | 1 | 15 000 | 2 | ~90 req/min |
| `kitsu` | 300 | 1 | 15 000 | 2 | generous, but be nice |
| `jimaku` | 500 | 1 | 20 000 | 2 | matches current per-item delay |
| `aniskip` | 350 | 2 | 5 000 | 1 | aniskip.com only; small |

### Behavior

- **Min-gap + concurrency** per key: a FIFO of pending jobs; a job starts when a
  slot is free *and* ≥ `minGapMs` has elapsed since the last start on that key.
  Generalizes `jikan.ts`'s `scheduleJikan` chain to N keys with a concurrency
  dial.
- **Retry** (`limitedFetch`): on `429`/`503`, read `Retry-After` (seconds or
  HTTP-date), wait `min(that, 30 s)`, retry up to `retries`; fall back to
  `2 s × attempt` when the header is absent. This is exactly today's `fetchJson`
  logic, promoted to all services. A non-retryable !ok is returned as-is (caller
  decides), except `limitedJson` throws `"<status> from <host>"`.
- **Timeout**: apply `AbortSignal.timeout(timeoutMs)` unless the caller passes
  their own `signal` in `init`.
- **Errors never wedge the queue**: a throwing/timing-out job releases its slot
  and still advances the min-gap timer (mirrors the `.catch` in `scheduleJikan`).

## Call-site migration

Each row is independently shippable + verifiable.

| # | Call site | Change | Verify by |
|---|---|---|---|
| 1 | `server/httpQueue.ts` (new) | build the limiter + unit tests | fake-timer tests (below) |
| 2 | `jikan.ts` | fold the **uncommitted gate** in as `key:'jikan'`; drop the local `jikanGate`/`jikanGet`; delete `sync.ts`'s 400/1000 ms Jikan sleeps | load `/manage/series/:id` (search + detail + episodes) — no 502; timing shows ~400 ms spacing |
| 3 | `aniskip.ts` | chain-walk Jikan calls → `limitedJson('jikan', …)` (**shares the gate — closes the bypass bug**); aniskip.com calls → `key:'aniskip'`; remove local `JIKAN_GAP_MS` | play an episode whose skip data needs a cold sequel-chain walk while also loading `/manage` — both resolve, no 429 |
| 4 | `flowNodes.ts` `fetchJson` | replace body with `limitedJson('tsukihime'\|'tosho', …)` (provider-keyed); drop the per-page `setTimeout` (the key's minGap replaces it) | library-import **dry run** — torrent-search node still returns results |
| 5 | `anilist.ts`, `banners.ts` (kitsu) | route through `limitedJson('anilist'\|'kitsu', …)`; drop `sync.ts`'s 300 ms AniList delay | trigger a portal sync for an uncatalogued series — banners still gather |
| 6 | `flowNodes.ts` `fetchSubs` `jimaku()` | route through `limitedFetch('jimaku', …)`; drop the 500 ms/item sleep | (needs `JIMAKU_API_KEY`) fetch-subs node returns |
| 7 | *(optional)* | `GET /api/flows/queue` + a small Activity-tab widget from `queueStats()` | shows live per-key inflight/queued during a flow run |

**Deliberately NOT migrated** (see non-goals): Jellyfin (`jellyfin.ts` jfJson +
byte-streaming proxy — our server, high-volume HLS, must stream not buffer),
qBit (`qbit.ts` — LAN, our service), Supabase auth (`index.ts` — per-request,
latency-critical), animeschedule scrape (`schedule.ts` — already 30-min cached,
single call).

## Validation

- **Unit tests** (`httpQueue`, fake timers): (a) two jobs on one key start
  ≥ `minGapMs` apart; (b) with `concurrency:1`, job B doesn't start until A
  settles; with `concurrency:2`, two run at once; (c) a `429 + Retry-After: 1`
  is retried after ~1 s and succeeds; (d) no `Retry-After` → exponential backoff;
  (e) a throwing job releases its slot (next job still runs); (f) timeout fires
  and doesn't wedge the key.
- **Per-migration smoke**, as in the table — each step exercises the real path
  on staging before the next.
- **Regression guard for the original bug**: with `jikan` at concurrency 1,
  hammer `searchAnime` + `fetchAnimeEpisodesPage` + the AniSkip chain-walk
  concurrently and assert **zero 429s** and monotonic ~400 ms spacing.

## Scope / non-goals

- **In-process, single-pod.** The limiter governs one pod. dev + prod are
  separate pods likely sharing an egress IP; if both hammer Jikan at once,
  per-pod limiters don't coordinate — the Retry-After retry absorbs the rare
  collision. Cross-pod coordination would need Redis; **explicitly out of scope**
  (massive overkill for this workload).
- No priority queue, no persistence, no cancellation, no dynamic
  reconfiguration at runtime — flows are already serialized by the flow lock.
- Not a general HTTP client (no caching, no auth injection); it's a limiter that
  wraps `fetch`. Callers keep building their own URLs/headers/bodies.
- Unbounded per-key queue (fine at our volume: tens of items). A `maxQueue`
  guard is a stretch, not a requirement.

## Load-bearing gotcha

**Never wrap a composite operation that itself enqueues on the same key** —
with `concurrency:1` that self-deadlocks (the outer job holds the only slot
while awaiting the inner). Enqueue **leaf fetches only**. AniSkip's chain-walk is
safe: it awaits each Jikan call *sequentially* in a loop, not nested inside
another enqueued job. Call this out in the module doc-comment.

## Deliverables checklist

- [ ] `server/httpQueue.ts` — limiter + config table + unit tests
- [ ] Migrate `jikan.ts` (absorb the uncommitted gate); drop `sync.ts` Jikan sleeps
- [ ] Migrate `aniskip.ts` (chain-walk → shared `jikan` key; own calls → `aniskip`)
- [ ] Migrate torrent-search `fetchJson` → provider-keyed `limitedJson`
- [ ] Migrate `anilist.ts` + Kitsu (`banners.ts`); drop `sync.ts` AniList delay
- [ ] Migrate Jimaku helper
- [ ] *(optional)* `queueStats()` + Activity-tab widget
- [ ] `npm run build:all`; per-step staging smoke; the concurrent-Jikan
      regression guard passes
- [ ] Version bump, commit to `dev`, verify on staging, then `dev → main` PR
```
