// Unified outbound-request limiter. Every external API we call (Jikan, TsukiHime,
// AniList, Kitsu, Jimaku, AniSkip, …) is rate-limited per *service key*: a minimum
// gap between request starts, a max concurrency, a per-request timeout, and a
// Retry-After-aware retry on 429/503. This replaces a scatter of per-module gates
// and ad-hoc setTimeout sleeps that didn't coordinate (two separate gates hit
// Jikan and could race past its ~3 req/s → a Cloudflare 502 the SPA can't parse).
//
// Deliberately in-process and single-pod: this is a single-admin server whose
// flows already run one-at-a-time behind a lock, so there's no scheduling /
// persistence problem to solve. Cross-pod coordination (Redis) is out of scope;
// the Retry-After retry absorbs the rare collision when dev+prod share an egress IP.
//
// DEADLOCK GOTCHA: never enqueue() a composite operation that itself enqueues on
// the *same* key — with concurrency 1 the outer job holds the only slot while
// awaiting the inner one, and both wedge forever. Enqueue leaf fetches only.

export interface QueueConfig {
  minGapMs: number
  concurrency: number
  timeoutMs: number
  retries: number
}

export interface QueueStat {
  inFlight: number
  queued: number
  minGapMs: number
  concurrency: number
  total: number
  /** Requests started in the last RATE_WINDOW_MS — the "is it busy *now*" signal. */
  recent: number
  retried: number
  lastStartAt: number | null
  lastError: { at: number; message: string } | null
}

interface QueueState {
  cfg: QueueConfig
  pending: Array<() => void>
  inFlight: number
  lastStartAt: number | null
  starts: number[]
  total: number
  retried: number
  lastError: { at: number; message: string } | null
}

// The lifetime total alone can't distinguish a boot-time burst four days ago
// from sustained traffic right now, so track a short rolling window too.
export const RATE_WINDOW_MS = 10 * 60 * 1000

// Rolling log of the most recent outbound requests, so the Activity page can
// show *what* the traffic was, not just per-service counts. URLs are logged as
// origin + pathname only — query strings can carry credentials (fanart.tv puts
// its api_key there).
export interface RequestLogEntry {
  at: number
  key: string
  method: string
  url: string
  /** HTTP status, or null when the request itself failed (timeout, DNS, …). */
  status: number | null
  ms: number
  error: string | null
}

const REQUEST_LOG_MAX = 100
const requestLog: RequestLogEntry[] = []

function sanitizeUrl(url: string | URL): string {
  try {
    const u = new URL(url)
    return u.origin + u.pathname
  } catch {
    return 'invalid-url'
  }
}

function logRequest(entry: RequestLogEntry): void {
  requestLog.push(entry)
  if (requestLog.length > REQUEST_LOG_MAX) requestLog.shift()
}

/** Most recent outbound requests, newest first. */
export function recentRequests(): RequestLogEntry[] {
  return [...requestLog].reverse()
}

type ServiceKey =
  | 'jikan'
  | 'tsukihime'
  | 'tosho'
  | 'anilist'
  | 'kitsu'
  | 'fanart'
  | 'jimaku'
  | 'aniskip'
  | 'itunes'
  | 'other'

// Starting values; each key is overridable via env HTTPQ_<KEY> as partial JSON,
// e.g. HTTPQ_JIKAN={"minGapMs":500}.
const DEFAULTS: Record<ServiceKey, QueueConfig> = {
  jikan: { minGapMs: 400, concurrency: 1, timeoutMs: 10_000, retries: 3 },
  tsukihime: { minGapMs: 1300, concurrency: 1, timeoutMs: 20_000, retries: 3 },
  tosho: { minGapMs: 500, concurrency: 1, timeoutMs: 20_000, retries: 3 },
  anilist: { minGapMs: 350, concurrency: 1, timeoutMs: 15_000, retries: 2 },
  kitsu: { minGapMs: 300, concurrency: 1, timeoutMs: 15_000, retries: 2 },
  fanart: { minGapMs: 300, concurrency: 1, timeoutMs: 15_000, retries: 2 },
  jimaku: { minGapMs: 500, concurrency: 1, timeoutMs: 20_000, retries: 2 },
  aniskip: { minGapMs: 350, concurrency: 2, timeoutMs: 5_000, retries: 1 },
  // iTunes Search allows ~20 req/min without a key — pace well under that.
  itunes: { minGapMs: 3100, concurrency: 1, timeoutMs: 10_000, retries: 1 },
  other: { minGapMs: 250, concurrency: 2, timeoutMs: 20_000, retries: 1 },
}

function loadConfig(key: ServiceKey): QueueConfig {
  // An unrecognised key would otherwise yield an undefined config, and every
  // fetch through it dies on a TypeError the caller sees only as a rejection.
  const base = DEFAULTS[key] ?? DEFAULTS.other
  const raw = process.env[`HTTPQ_${key.toUpperCase()}`]
  if (!raw) return base
  try {
    const patch = JSON.parse(raw) as Partial<QueueConfig>
    return { ...base, ...patch }
  } catch {
    console.error(`httpQueue: ignoring invalid HTTPQ_${key.toUpperCase()} env`)
    return base
  }
}

const queues = new Map<string, QueueState>()

function stateFor(key: string): QueueState {
  let q = queues.get(key)
  if (!q) {
    q = {
      cfg: loadConfig(key as ServiceKey),
      pending: [],
      inFlight: 0,
      lastStartAt: null,
      starts: [],
      total: 0,
      retried: 0,
      lastError: null,
    }
    queues.set(key, q)
  }
  return q
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Drop window-expired entries. Starts are appended in time order, so shift from the front. */
function pruneStarts(q: QueueState): void {
  const cutoff = Date.now() - RATE_WINDOW_MS
  while (q.starts.length > 0 && q.starts[0] < cutoff) q.starts.shift()
}

/**
 * Acquire a slot on `key`: waits until concurrency has room AND at least
 * `minGapMs` has elapsed since the last start. Returns once the caller may run.
 */
async function acquire(q: QueueState): Promise<void> {
  if (q.inFlight >= q.cfg.concurrency) {
    await new Promise<void>((resolve) => q.pending.push(resolve))
  }
  q.inFlight++
  if (q.lastStartAt != null) {
    const wait = q.cfg.minGapMs - (Date.now() - q.lastStartAt)
    if (wait > 0) await sleep(wait)
  }
  q.lastStartAt = Date.now()
}

/** Release the slot and wake the next waiter. Always runs, even on error. */
function release(q: QueueState): void {
  q.inFlight--
  const next = q.pending.shift()
  if (next) next()
}

/**
 * Run `fn` under `key`'s limiter (min-gap + concurrency). The slot is released
 * (and the min-gap timer has already advanced) even if `fn` throws, so a failing
 * job never wedges the queue.
 */
export async function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const q = stateFor(key)
  await acquire(q)
  q.total++
  q.starts.push(Date.now())
  pruneStarts(q)
  try {
    return await fn()
  } finally {
    release(q)
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) to a millisecond wait. */
function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('retry-after')
  if (!h) return null
  const secs = Number(h)
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000
  const date = Date.parse(h)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return null
}

function hostOf(url: string | URL): string {
  try {
    return new URL(url).host
  } catch {
    return 'unknown'
  }
}

/**
 * fetch through the limiter, with a per-request timeout and Retry-After-aware
 * retry on 429/503. Returns the raw Response (the caller decides what !ok means);
 * a non-retryable error status is NOT thrown. Honours a caller-supplied
 * `init.signal` in place of the default timeout.
 */
export function limitedFetch(
  key: string,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const q = stateFor(key)
  return enqueue(key, async () => {
    const startedAt = Date.now()
    const method = (init.method ?? 'GET').toUpperCase()
    const logged = sanitizeUrl(url)
    for (let attempt = 0; ; attempt++) {
      const signal = init.signal ?? AbortSignal.timeout(q.cfg.timeoutMs)
      let res: Response
      try {
        res = await fetch(url, { ...init, signal })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        q.lastError = { at: Date.now(), message }
        logRequest({ at: startedAt, key, method, url: logged, status: null, ms: Date.now() - startedAt, error: message })
        throw e
      }
      if ((res.status === 429 || res.status === 503) && attempt < q.cfg.retries) {
        const wait = retryAfterMs(res) ?? 2000 * (attempt + 1)
        q.retried++
        q.lastError = { at: Date.now(), message: `${res.status} from ${hostOf(url)}, retrying` }
        await sleep(Math.min(wait, 30_000))
        continue
      }
      logRequest({ at: startedAt, key, method, url: logged, status: res.status, ms: Date.now() - startedAt, error: null })
      return res
    }
  })
}

/** limitedFetch + ok check + JSON parse. Throws `"<status> <text> from <host>"` on !ok. */
export async function limitedJson(
  key: string,
  url: string | URL,
  init?: RequestInit,
): Promise<unknown> {
  const res = await limitedFetch(key, url, init)
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText} from ${hostOf(url)}`)
    stateFor(key).lastError = { at: Date.now(), message: err.message }
    throw err
  }
  return res.json()
}

// Map a URL's host to its service key, so generic callers (e.g. the source.http
// flow node) get keyed limiting without naming a service.
const HOST_KEYS: Array<[RegExp, ServiceKey]> = [
  [/(^|\.)jikan\.moe$/i, 'jikan'],
  [/(^|\.)tsukihime\.org$/i, 'tsukihime'],
  [/(^|\.)animetosho\.\w+$/i, 'tosho'],
  [/(^|\.)anilist\.co$/i, 'anilist'],
  [/(^|\.)kitsu\.(io|app)$/i, 'kitsu'],
  [/(^|\.)fanart\.tv$/i, 'fanart'],
  [/(^|\.)jimaku\.cc$/i, 'jimaku'],
  [/(^|\.)aniskip\.com$/i, 'aniskip'],
]

export function hostKey(url: string | URL): ServiceKey | 'other' {
  const host = hostOf(url)
  for (const [re, key] of HOST_KEYS) {
    if (re.test(host)) return key
  }
  return 'other'
}

/** Live snapshot of every queue that has been touched this process. */
export function queueStats(): Record<string, QueueStat> {
  const out: Record<string, QueueStat> = {}
  for (const [key, q] of queues) {
    pruneStarts(q)
    out[key] = {
      inFlight: q.inFlight,
      queued: q.pending.length,
      minGapMs: q.cfg.minGapMs,
      concurrency: q.cfg.concurrency,
      total: q.total,
      recent: q.starts.length,
      retried: q.retried,
      lastStartAt: q.lastStartAt,
      lastError: q.lastError,
    }
  }
  return out
}
