// Sourcing reconciliation: cross-checks the torrent ledger, the wants table,
// the per-file library ledger, and live qBittorrent, so nothing the flows
// queue can silently drift out of tracking. Read report + two idempotent
// fixers (backfill = adopt pre-ledger history; reconcile = safe corrections).

import fs from 'node:fs'
import path from 'node:path'
import {
  listAnimeSeries,
  listWants,
  listLibraryFiles,
  forgetLibraryFile,
  getCachedEpisodes,
  getSeriesStatus,
  getTorrent,
  recordTorrentQueued,
  setTorrentStatus,
  recordTorrentOutcome,
  upsertWant,
  updateWantStatus,
  getDb,
  type TorrentRow,
  type WantRow,
} from './db.js'
import {
  qbitConfigured,
  qbitList,
  qbitDelete,
  qbitFreeSpace,
  parseTorrentTags,
  type QbitTorrent,
} from './qbit.js'
import { refreshEpisodeCache } from './episodes.js'
import { cfgSafe, cfgNum, cfgBool } from './config.js'
import { sectionLibraryRoot } from './sections.js'

// qBittorrent is shared between prod and staging; each environment owns one
// category (QBIT_CATEGORY: prod 'anime', staging 'anime-dev'). Reconciliation
// must only look at THIS environment's slice, or prod's backfill would adopt
// dev's torrents into prod's ledger (and each env would report the other's
// torrents as orphans).
const ourCategory = () => cfgSafe('QBIT_CATEGORY') || 'anime'
async function qbitListOurs(): Promise<QbitTorrent[]> {
  const cat = ourCategory()
  return (await qbitList()).filter((t) => t.category === cat)
}

function allTorrentRows(): TorrentRow[] {
  return getDb().prepare('SELECT * FROM torrents').all() as TorrentRow[]
}

const LIVE_STATUSES = new Set(['queued', 'downloading', 'completed', 'imported'])

export interface SourcingLedgerReport {
  qbitConfigured: boolean
  counts: { torrents: Record<string, number>; wants: Record<string, number> }
  /** In qBittorrent but unknown to the torrent ledger (pre-ledger or hand-added). */
  qbitOrphans: { hash: string; name: string; category: string; progress: number; tags: string }[]
  /** Ledger says live (queued/downloading/completed/imported) but qBittorrent no longer has it. */
  ledgerOrphans: { hash: string; name: string | null; status: string; mal_id: number | null }[]
  /** Completed >24h ago and neither imported nor exhausted — the import flow is not consuming them. */
  staleCompleted: { hash: string; name: string | null; completed_at: string | null; mal_id: number | null }[]
  /** Sourced wants whose torrent is gone/cleaned/failed — they will never fulfil. */
  sourcedWantsDeadTorrent: { want_id: number; mal_id: number; episode: number | null; torrent_hash: string | null; torrent_status: string | null }[]
  /** Fulfilled wants whose library file no longer exists on disk — the chase
   * renders these as "importing" forever unless reopened (phantom rows from a
   * DB clone, or a file deleted out-of-band). */
  fulfilledWantsMissingFile: { want_id: number; mal_id: number; episode: number | null; library_path: string | null }[]
}

export async function sourcingLedger(
  opts: {
    /** Already-fetched live slice. The series page needs qBittorrent for its
     * own download list anyway, and it polls every few seconds while a download
     * runs — re-querying here would double that load for no new information. */
    live?: QbitTorrent[] | null
  } = {},
): Promise<SourcingLedgerReport> {
  const rows = allTorrentRows()
  const byHash = new Map(rows.map((r) => [r.hash, r]))
  const configured = qbitConfigured()
  let live: QbitTorrent[] = opts.live ?? []
  if (configured && opts.live == null) live = await qbitListOurs()
  const liveByHash = new Map(live.map((t) => [t.hash.toLowerCase(), t]))

  const counts = (list: { status: string }[]) => {
    const out: Record<string, number> = {}
    for (const r of list) out[r.status] = (out[r.status] ?? 0) + 1
    return out
  }

  const qbitOrphans = live
    .filter((t) => !byHash.has(t.hash.toLowerCase()))
    .map((t) => ({
      hash: t.hash.toLowerCase(),
      name: t.name,
      category: t.category,
      progress: t.progress,
      tags: t.tags ?? '',
    }))

  // Only judge rows that belong to our category (or predate the column):
  // a row recorded under the other environment's category can never appear in
  // our live slice, so "missing from qBit" would be meaningless for it.
  const cat = ourCategory()
  const ledgerOrphans = configured
    ? rows
        .filter(
          (r) =>
            LIVE_STATUSES.has(r.status) &&
            (r.category == null || r.category === cat) &&
            !liveByHash.has(r.hash),
        )
        .map((r) => ({ hash: r.hash, name: r.name, status: r.status, mal_id: r.mal_id }))
    : []

  const dayAgo = Date.now() - 24 * 3600_000
  const staleCompleted = rows
    .filter(
      (r) =>
        r.status === 'completed' &&
        // Foreign-category rows (other env / other tools on the shared qBit)
        // are not ours to consume — same exclusion as ledgerOrphans above.
        (r.category == null || r.category === cat) &&
        r.completed_at != null &&
        new Date(r.completed_at + 'Z').getTime() < dayAgo,
    )
    .map((r) => ({ hash: r.hash, name: r.name, completed_at: r.completed_at, mal_id: r.mal_id }))

  const wants = listWants()
  const sourcedWantsDeadTorrent = wants
    .filter((w) => w.status === 'sourced')
    .map((w) => {
      const t = w.torrent_hash ? byHash.get(w.torrent_hash) : undefined
      const liveT = w.torrent_hash ? liveByHash.get(w.torrent_hash) : undefined
      const dead =
        !w.torrent_hash ||
        (!liveT && configured && (!t || LIVE_STATUSES.has(t.status))) ||
        // `exhausted` belongs here too: the torrent is alive and complete in
        // qBittorrent, but the import flow found nothing importable in it, so it
        // will never fulfil the want and `source.qbittorrent` skips it forever.
        // Without this the want is invisible to reconcile and sits `sourced`
        // indefinitely — episodeChase.ts already tells the UI "the reconciler
        // will reopen it", which was not true until now.
        (t != null &&
          (t.status === 'failed' ||
            t.status === 'cleaned' ||
            t.status === 'superseded' ||
            t.status === 'exhausted'))
      return dead
        ? {
            want_id: w.id,
            mal_id: w.mal_id,
            episode: w.episode,
            torrent_hash: w.torrent_hash,
            torrent_status: t?.status ?? null,
          }
        : null
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  // Fulfilled wants whose backing file is gone from disk. "Fulfilled" must
  // mean a real on-disk file — when provenance and disk disagree, reconcile
  // toward disk truth instead of rendering "importing" forever. Conservative:
  // only flagged when we can point at a concrete missing path (the want's own
  // library_path, or its episode's library_files row).
  const root = sectionLibraryRoot('anime')
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(root, p))
  const libByEp = new Map<string, string>()
  for (const f of listLibraryFiles()) {
    if (f.mal_id != null && f.episode != null) libByEp.set(`${f.mal_id}:${f.episode}`, f.path)
  }
  const offsetByMal = new Map(listAnimeSeries().map((s) => [s.mal_id, s.episode_offset ?? 0]))
  const fulfilledWantsMissingFile: SourcingLedgerReport['fulfilledWantsMissingFile'] = []
  for (const w of wants) {
    if (w.status !== 'fulfilled') continue
    let candidate: string | null = null
    if (w.library_path) {
      candidate = abs(w.library_path)
    } else if (w.kind === 'episode' && w.episode != null) {
      const rel = libByEp.get(`${w.mal_id}:${w.episode + (offsetByMal.get(w.mal_id) ?? 0)}`)
      if (rel) candidate = abs(rel)
    }
    if (candidate && !fs.existsSync(candidate)) {
      fulfilledWantsMissingFile.push({
        want_id: w.id,
        mal_id: w.mal_id,
        episode: w.episode,
        library_path: candidate,
      })
    }
  }

  return {
    qbitConfigured: configured,
    counts: { torrents: counts(rows), wants: counts(wants) },
    qbitOrphans,
    ledgerOrphans,
    staleCompleted,
    sourcedWantsDeadTorrent,
    fulfilledWantsMissingFile,
  }
}

export interface BackfillResult {
  dryRun: boolean
  adoptedFromQbit: number
  adoptedFromLibrary: number
  wantsFulfilled: number
  /** library_files rows pointing at a path that is not on disk — skipped rather
   * than turned into a `fulfilled` want the reconciler would immediately reopen.
   * A non-zero count means the file ledger has drifted from disk. */
  skippedMissingFile: number
}

/**
 * Adopt history the ledger predates: every qBittorrent torrent gets a row
 * (identity from our own queue-time tags; status inferred from progress +
 * library_files), every imported library file's hash gets an `imported` row,
 * and each (mal, episode) already in the library gets a fulfilled want so the
 * chase UI has continuity. Idempotent — existing rows are left untouched.
 */
export async function sourcingBackfill(dryRun: boolean): Promise<BackfillResult> {
  const libFiles = listLibraryFiles()
  const libHashes = new Set(
    libFiles.map((f) => (f.torrent_hash ?? '').toLowerCase()).filter(Boolean),
  )
  const seriesByMal = new Map(listAnimeSeries().map((s) => [s.mal_id, s]))

  let adoptedFromQbit = 0
  let adoptedFromLibrary = 0
  let wantsFulfilled = 0
  let skippedMissingFile = 0

  if (qbitConfigured()) {
    for (const t of await qbitListOurs()) {
      const hash = t.hash.toLowerCase()
      if (getTorrent(hash)) continue
      adoptedFromQbit++
      if (dryRun) continue
      const tags = parseTorrentTags(t.tags)
      recordTorrentQueued({
        hash,
        mal_id: tags.tag_mal_id,
        kind: tags.tag_episode != null ? 'episode' : null,
        episode: tags.tag_episode,
        tvdb_season: tags.tag_season,
        name: t.name,
        category: t.category,
        provider: 'backfill',
        size: t.size,
      })
      if (libHashes.has(hash)) {
        recordTorrentOutcome({ hash, mal_id: tags.tag_mal_id }, 'imported', {
          note: 'backfill: hash present in library_files',
        })
      } else if (t.progress >= 1) {
        setTorrentStatus(hash, 'completed', 'backfill: qBittorrent reports complete')
      }
    }
  }

  // Library files whose torrent vanished from qBit still deserve a row.
  for (const f of libFiles) {
    const hash = (f.torrent_hash ?? '').toLowerCase()
    if (!hash || getTorrent(hash)) continue
    adoptedFromLibrary++
    if (dryRun) continue
    recordTorrentQueued({
      hash,
      mal_id: f.mal_id,
      kind: 'episode',
      episode: null, // library episode is post-offset; identity below on the want side
      tvdb_season: f.tvdb_season,
      provider: 'backfill',
    })
    recordTorrentOutcome({ hash, mal_id: f.mal_id }, 'imported', {
      note: 'backfill: from library_files (torrent no longer in qBittorrent)',
    })
  }

  // Fulfilled wants for what the library already holds — MAL per-cour episode
  // space, so reverse the series' episode_offset from the stored number.
  //
  // "Already holds" has to mean a file that is actually on disk, not merely a
  // library_files row. Those rows drift (a hand-moved file, a path written
  // before normalisation, a restored DB), and minting a `fulfilled` want from a
  // stale one is actively harmful: the periodic reconcile then finds a fulfilled
  // want whose file is missing, correctly reopens it, and the chase downloads a
  // show we already have. That happened on production — 12 episodes of a
  // finished show reopened and queued off stale rows. Verify the path first.
  const libRoot = sectionLibraryRoot('anime')
  const libAbs = (p: string) => (path.isAbsolute(p) ? p : path.join(libRoot, p))
  const seen = new Set<string>()
  for (const f of libFiles) {
    if (f.mal_id == null || f.episode == null) continue
    if (!f.path || !fs.existsSync(libAbs(f.path))) {
      skippedMissingFile++
      continue
    }
    const s = seriesByMal.get(f.mal_id)
    const malEp = f.episode - (s?.episode_offset ?? 0)
    if (!Number.isFinite(malEp) || malEp < 1) continue
    const key = `${f.mal_id}:${malEp}`
    if (seen.has(key)) continue
    seen.add(key)
    // Only count wants that actually change (dry-run counts must match what a
    // live run would do, and a re-run must report 0).
    const existing = getDb()
      .prepare(`SELECT status FROM wants WHERE mal_id = ? AND kind = 'episode' AND episode = ?`)
      .get(f.mal_id, malEp) as { status: string } | undefined
    if (existing?.status === 'fulfilled') continue
    wantsFulfilled++
    if (dryRun) continue
    const r = upsertWant({ mal_id: f.mal_id, kind: 'episode', episode: malEp, reason: 'backfill' })
    if (r.want.status !== 'fulfilled') {
      updateWantStatus(r.want.id, 'fulfilled', 'backfill: already in library')
    }
  }

  return { dryRun, adoptedFromQbit, adoptedFromLibrary, wantsFulfilled, skippedMissingFile }
}

// --- Airing-shows want sweep -------------------------------------------------

/**
 * An aired episode we hold no want for. Reported by `sourcingSweep` and, when
 * not a dry run, turned into an open want.
 */
export interface SweptEpisode {
  mal_id: number
  title: string
  episode: number
  airedAt: string
}

export interface SweepResult {
  dryRun: boolean
  /** Catalog rows the sweep looked at (airing, non-movie). */
  seriesConsidered: number
  /** Aired episodes that had no want row — opened unless dryRun. */
  wantsOpened: SweptEpisode[]
  /** Series whose episode-cache refresh threw (their air dates may be stale). */
  refreshFailures: { mal_id: number; error: string }[]
}

/** Never open more than this many wants for one series in a single sweep. A
 * mis-set air_status on a long finished show would otherwise queue a whole
 * back catalog in one pass; a weekly show can only ever need one. */
const SWEEP_MAX_PER_SERIES = 26

/**
 * The backstop that makes "currently airing shows get sourced automatically"
 * true without depending on the schedule scrape.
 *
 * The event path (`trigger.release` → the "Release aired" flow) is the fast
 * path, but it is built on animeschedule.net's homepage and a fuzzy library
 * title match, which is season-blind by construction: `baseTitle` deliberately
 * strips "Season 3" so a cour matches its parent show, and the scraped "Ep 12"
 * label is the show's continuing number, not the cour's. For a multi-cour show
 * in the catalog as several mal_id rows (Mushoku Tensei S1/II/S3 all share
 * tvdb 371310) that files the want against the wrong cour at an episode number
 * that cour never had — which then never finds a release — while the episode
 * that actually aired is left with no want at all and silently stops being
 * chased. It also only ever sees the current week, so a miss is permanent.
 *
 * This pass owes nothing to any of that. It walks each airing catalog row
 * against *its own* cached AniList air dates, keyed on its own mal_id in its
 * own per-cour episode numbering, and opens a want for anything that has aired
 * and isn't already held or tracked. Idempotent: `upsertWant` without `reopen`
 * leaves fulfilled and admin-abandoned wants alone, so a re-run is a no-op.
 */
export async function sourcingSweep(dryRun: boolean): Promise<SweepResult> {
  const now = Date.now()
  const wantsOpened: SweptEpisode[] = []
  const refreshFailures: { mal_id: number; error: string }[] = []
  let seriesConsidered = 0

  // Episodes already on disk, in each cour's own MAL numbering (library rows
  // store the post-offset absolute slot — reverse it, as backfill does).
  const offsets = new Map(listAnimeSeries().map((s) => [s.mal_id, s.episode_offset ?? 0]))
  const inLibrary = new Set<string>()
  for (const f of listLibraryFiles()) {
    if (f.mal_id == null || f.episode == null) continue
    inLibrary.add(`${f.mal_id}:${f.episode - (offsets.get(f.mal_id) ?? 0)}`)
  }

  const wanted = new Set(
    (
      getDb()
        .prepare(`SELECT mal_id, episode FROM wants WHERE kind = 'episode' AND episode IS NOT NULL`)
        .all() as { mal_id: number; episode: number }[]
    ).map((w) => `${w.mal_id}:${w.episode}`),
  )
  // A batch want covers every episode of its show — a season pack is already
  // being chased, so per-episode wants alongside it would double-source.
  const batchWanted = new Set(
    (
      getDb()
        .prepare(`SELECT mal_id FROM wants WHERE kind = 'batch' AND status IN ('open','sourced')`)
        .all() as { mal_id: number }[]
    ).map((w) => w.mal_id),
  )

  for (const s of listAnimeSeries()) {
    const status = getSeriesStatus(s.mal_id)
    if (status?.is_movie) continue
    // Only shows we believe are mid-broadcast. 'finished' is terminal (a gap in
    // a finished show is a backfill question, not a keeping-up one) and an
    // unresolved row has no air dates worth trusting yet.
    if (status?.air_status !== 'airing') continue
    seriesConsidered++
    if (batchWanted.has(s.mal_id)) continue

    // Cache-first (AniList, 6h TTL internally) — a weekly show needs at most
    // one upstream call per sweep window, usually none.
    try {
      await refreshEpisodeCache({
        mal_id: s.mal_id,
        finished: false,
        totalEpisodes: status.total_episodes ?? s.episodes ?? null,
      })
    } catch (e) {
      refreshFailures.push({ mal_id: s.mal_id, error: e instanceof Error ? e.message : String(e) })
    }

    const total = status.total_episodes ?? s.episodes ?? null
    let opened = 0
    for (const ep of getCachedEpisodes(s.mal_id)) {
      if (opened >= SWEEP_MAX_PER_SERIES) break
      if (!ep.aired) continue // no air date = nothing to assert about it
      const airedAt = new Date(ep.aired)
      if (!Number.isFinite(airedAt.getTime()) || airedAt.getTime() > now) continue
      if (total != null && total > 0 && ep.number > total) continue
      const key = `${s.mal_id}:${ep.number}`
      if (inLibrary.has(key) || wanted.has(key)) continue
      opened++
      wanted.add(key) // keep the dry-run report identical to what a live run does
      wantsOpened.push({ mal_id: s.mal_id, title: s.title, episode: ep.number, airedAt: ep.aired })
      if (dryRun) continue
      upsertWant({ mal_id: s.mal_id, kind: 'episode', episode: ep.number, reason: 'airing-sweep' })
    }
  }

  return { dryRun, seriesConsidered, wantsOpened, refreshFailures }
}

/** One live torrent the reconcile judged by its qBittorrent state. */
export interface ReconcileTorrent {
  hash: string
  name: string
  state: string
  progress: number
  /** Hours since qBittorrent last saw data move (since it was added, if never). */
  idleHours: number
  /** Sourced wants this torrent was queued for. */
  want_ids: number[]
}

export interface ReconcileResult {
  dryRun: boolean
  /** live-status ledger rows with no qBit torrent → cleaned (imported) / failed (never completed). */
  orphanRowsClosed: number
  /** sourced wants whose torrent is gone (or dead in the ledger) → reopened. */
  wantsReopened: number
  /** fulfilled wants whose file vanished → reopened; dead library_files rows dropped. */
  phantomFulfilledReopened: number
  /** SOURCING_STALL_HOURS in force for this pass. */
  stallHours: number
  /** Stalled past stallHours → wants reopened, ledger cleaned (re-queue blocked), torrent removed
   * (with its partial files when SOURCING_STALL_DELETE_FILES). */
  stalled: ReconcileTorrent[]
  /** Stalled, but qBittorrent saw data move within stallHours — left alone. */
  stalledWaiting: number
  /** missingFiles → wants reopened, ledger cleaned (re-queue blocked), torrent entry removed (no files to delete). */
  missingFiles: ReconcileTorrent[]
  /** qBittorrent `error` (a full disk, usually) — never touched: qBittorrent can
   * resume these once the cause clears, and deleting them throws the partial
   * download away. Every torrent in our category, want-linked or not. */
  errored: ReconcileTorrent[]
  /** qBittorrent's free_space_on_disk, fetched only when something is errored. */
  freeBytes: number | null
}

/**
 * qBittorrent states meaning "wants data, none is arriving". `stalledDL` is
 * routinely transient (no peers for a moment), so a stall is only acted on once
 * qBittorrent's own clock says nothing moved for SOURCING_STALL_HOURS. A magnet
 * that never resolves its metadata sits in metaDL forever — the same failure.
 */
const STALL_STATES = new Set(['stalledDL', 'metaDL', 'forcedMetaDL'])

function idleHours(t: QbitTorrent, nowSec: number): number {
  const since = Math.max(t.last_activity ?? 0, t.added_on ?? 0)
  // No timestamp at all means we can't tell how long it has been idle — read
  // it as "just now" so it is never given up on blind.
  return since > 0 ? Math.max(0, (nowSec - since) / 3600) : 0
}

function stallHoursSetting(): number {
  const n = cfgNum('SOURCING_STALL_HOURS', 24)
  return n > 0 ? n : 24
}

/**
 * The live-state half of reconcile: torrents that ARE still in qBittorrent but
 * will never fulfil their want. This replaced the "Unstick sourcing" flow, which
 * deleted torrents and their files the first time it saw stalledDL or error.
 *
 * Every write is claimed through a `status = 'sourced' AND torrent_hash = ?`
 * guard, and a torrent is only removed when this pass actually reopened one of
 * its wants. So a pass that loses a race (the old flow, or a second reconcile,
 * reopened the want first) changes nothing — no double reopen, no double delete.
 */
async function reconcileLiveStates(
  live: QbitTorrent[],
  dryRun: boolean,
): Promise<Pick<ReconcileResult, 'stallHours' | 'stalled' | 'stalledWaiting' | 'missingFiles' | 'errored' | 'freeBytes'>> {
  const stallHours = stallHoursSetting()
  const nowSec = Date.now() / 1000
  const wantsByHash = new Map<string, number[]>()
  for (const w of listWants('sourced')) {
    if (!w.torrent_hash) continue
    const h = w.torrent_hash.toLowerCase()
    wantsByHash.set(h, [...(wantsByHash.get(h) ?? []), w.id])
  }

  const stalled: ReconcileTorrent[] = []
  const missingFiles: ReconcileTorrent[] = []
  const errored: ReconcileTorrent[] = []
  let stalledWaiting = 0
  for (const t of live) {
    const hash = t.hash.toLowerCase()
    const view: ReconcileTorrent = {
      hash,
      name: t.name,
      state: t.state,
      progress: t.progress,
      idleHours: Math.round(idleHours(t, nowSec) * 10) / 10,
      want_ids: wantsByHash.get(hash) ?? [],
    }
    if (t.state === 'error') {
      errored.push(view)
      continue
    }
    // Stalls and missing files are only ours to act on when a want is waiting
    // on the torrent; anything else in the category is someone's by-hand add.
    if (view.want_ids.length === 0) continue
    if (t.state === 'missingFiles') missingFiles.push(view)
    else if (STALL_STATES.has(t.state)) {
      if (idleHours(t, nowSec) >= stallHours) stalled.push(view)
      else stalledWaiting++
    }
  }

  let freeBytes: number | null = null
  if (errored.length > 0) freeBytes = await qbitFreeSpace().catch(() => null)

  if (!dryRun) {
    const deleteFiles = cfgBool('SOURCING_STALL_DELETE_FILES', true)
    const claim = getDb().prepare(
      `UPDATE wants SET status = 'open', note = ?, updated_at = datetime('now')
       WHERE id = ? AND status = 'sourced' AND torrent_hash = ?`,
    )
    // Reopen the wants and retire the ledger row; returns whether we won the
    // claim. `cleaned`, not `failed`: blockedTorrentHashes exempts only
    // `failed`, so a failed row would let the chase re-queue the same dead
    // release. A `cleaned` hash is refused, and the sink's re-pick branch backs
    // the want off instead. (Not `exhausted` — its admin "retry import" would
    // flip a never-finished download to `completed`.)
    const settle = (v: ReconcileTorrent, why: string): boolean => {
      const note = `reconcile: torrent ${v.hash} ${why}`
      let claimed = 0
      for (const id of v.want_ids) claimed += claim.run(note, id, v.hash).changes
      if (claimed === 0) return false
      setTorrentStatus(v.hash, 'cleaned', `reconcile: gave up — ${why}`)
      return true
    }
    const stalledOut = stalled
      .filter((v) => settle(v, `${v.state}, no activity for ${Math.round(v.idleHours)}h`))
      .map((v) => v.hash)
    const missingOut = missingFiles.filter((v) => settle(v, 'missingFiles')).map((v) => v.hash)
    // Ledger + wants are already settled, so a failed delete only leaves a dead
    // entry in qBittorrent (and the next pass's gone-path finds nothing to do).
    await qbitDelete(stalledOut, deleteFiles)
    await qbitDelete(missingOut, false)
  }

  return { stallHours, stalled, stalledWaiting, missingFiles, errored, freeBytes }
}

/**
 * Whether it is unsafe to run an *unattended* reconcile right now, because
 * qBittorrent's answer can't be trusted. qBit unreachable (qbitList throws) or
 * — the subtler trap — configured but answering an empty list while we still
 * track live torrents: that is the mid-restart blip signature, and reconciling
 * on it would read every live torrent as an orphan and reopen every want,
 * spawning duplicate downloads. The manual `POST /api/sourcing/reconcile` has a
 * human watching and skips this guard; the scheduler's periodic pass uses it.
 */
export async function qbitReconcileUnsafe(): Promise<boolean> {
  if (!qbitConfigured()) return false // nothing qBit-derived to get wrong
  let live: QbitTorrent[]
  try {
    live = await qbitListOurs()
  } catch {
    return true // unreachable — don't judge orphans off a failed fetch
  }
  if (live.length > 0) return false
  const cat = ourCategory()
  return allTorrentRows().some(
    (r) => LIVE_STATUSES.has(r.status) && (r.category == null || r.category === cat),
  )
}

/** Apply the safe fixes for what `sourcingLedger` reports. */
export async function sourcingReconcile(dryRun: boolean): Promise<ReconcileResult> {
  // One qBittorrent read serves both halves: the ledger (gone torrents) and the
  // live-state pass (stalled / missingFiles / error).
  const live = qbitConfigured() ? await qbitListOurs() : []
  const report = await sourcingLedger({ live })
  let orphanRowsClosed = 0
  let wantsReopened = 0
  let phantomFulfilledReopened = 0

  for (const o of report.ledgerOrphans) {
    orphanRowsClosed++
    if (dryRun) continue
    // An imported torrent that left qBit was cleaned up; anything else that
    // vanished without importing failed.
    setTorrentStatus(o.hash, o.status === 'imported' ? 'cleaned' : 'failed', 'reconcile: not in qBittorrent')
  }

  for (const w of report.sourcedWantsDeadTorrent) {
    wantsReopened++
    if (dryRun) continue
    updateWantStatus(w.want_id, 'open', `reconcile: torrent ${w.torrent_hash ?? '?'} ${w.torrent_status ?? 'gone'}`)
  }

  // Phantom fulfilled: reopen the want, drop the dead library_files row, and
  // demote its torrent if that row was the only thing calling it imported —
  // otherwise the dup-guard would refuse the re-queue and the fulfil-on-skip
  // path would just re-fulfil the want against the same phantom.
  const db = getDb()
  const root = sectionLibraryRoot('anime')
  for (const w of report.fulfilledWantsMissingFile) {
    phantomFulfilledReopened++
    if (dryRun) continue
    const want = db.prepare('SELECT * FROM wants WHERE id = ?').get(w.want_id) as WantRow | undefined
    const hash = want?.torrent_hash ?? null
    if (w.library_path) {
      const rel = path.isAbsolute(w.library_path) ? path.relative(root, w.library_path) : w.library_path
      forgetLibraryFile(rel)
      forgetLibraryFile(w.library_path) // rows written pre-normalisation stored absolute paths
    }
    db.prepare(
      `UPDATE wants SET status = 'open', torrent_hash = NULL, library_path = NULL,
         note = 'reconcile: fulfilled but file missing on disk', updated_at = datetime('now')
       WHERE id = ?`,
    ).run(w.want_id)
    if (hash) {
      const stillReferenced = db
        .prepare(`SELECT 1 FROM library_files WHERE torrent_hash = ? LIMIT 1`)
        .get(hash)
      const t = getTorrent(hash)
      if (!stillReferenced && t?.status === 'imported') {
        setTorrentStatus(hash, 'failed', 'reconcile: imported but no library file survives')
      }
    }
  }

  const liveStates = await reconcileLiveStates(live, dryRun)

  return { dryRun, orphanRowsClosed, wantsReopened, phantomFulfilledReopened, ...liveStates }
}

/**
 * Put an `exhausted` torrent back in front of the import flow.
 *
 * `exhausted` means every file in it was skipped for a terminal reason — most
 * often `unresolved-episode`, i.e. no episode number could be parsed from the
 * filenames. The torrent is still sitting in qBittorrent fully downloaded, but
 * `source.qbittorrent` skips exhausted hashes forever, so once the cause is
 * fixed there is otherwise no way to make the import reconsider it.
 *
 * Deliberately human-triggered only — nothing calls this on a timer. An
 * automatic retry would loop forever against a torrent that is genuinely
 * unimportable (import → exhausted → retry → import → …).
 */
export function retryExhaustedTorrent(hash: string): {
  ok: boolean
  hash: string
  status: string | null
  reason?: string
} {
  const h = hash.trim().toLowerCase()
  const t = getTorrent(h)
  if (!t) return { ok: false, hash: h, status: null, reason: 'not in the torrent ledger' }
  if (t.status !== 'exhausted') {
    return { ok: false, hash: h, status: t.status, reason: 'only an exhausted torrent can be retried' }
  }
  setTorrentStatus(h, 'completed', 'admin: retry import after exhausted')
  return { ok: true, hash: h, status: 'completed' }
}

/** Admin action on a single want (SeriesDetail chase panel). */
export function wantAction(
  wantId: number,
  action: 'retry-now' | 'abandon' | 'reopen',
): WantRow | undefined {
  const db = getDb()
  if (action === 'retry-now') {
    db.prepare(
      `UPDATE wants SET next_attempt_at = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'open'`,
    ).run(wantId)
  } else if (action === 'abandon') {
    updateWantStatus(wantId, 'abandoned', 'admin: abandoned')
  } else {
    db.prepare(
      `UPDATE wants SET status = 'open', attempts = 0, next_attempt_at = NULL, note = 'admin: reopened',
         torrent_hash = NULL, library_path = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(wantId)
  }
  return db.prepare('SELECT * FROM wants WHERE id = ?').get(wantId) as WantRow | undefined
}

/** The want (and its ledger torrent) for a series' chase target, if any. */
export function wantForEpisode(
  mal_id: number,
  episode: number,
): { want: WantRow; torrent: TorrentRow | null } | null {
  const want = getDb()
    .prepare(
      `SELECT * FROM wants WHERE mal_id = ? AND (
         (kind = 'episode' AND episode = ?) OR kind = 'batch'
       ) ORDER BY kind = 'episode' DESC LIMIT 1`,
    )
    .get(mal_id, episode) as WantRow | undefined
  if (!want) return null
  const torrent = want.torrent_hash ? (getTorrent(want.torrent_hash) ?? null) : null
  return { want, torrent }
}

/**
 * The checks `sourcingLedger()` already runs, narrowed to one series.
 *
 * Exists because these problems were only ever visible on a global admin route
 * that nobody opens per title. A stuck series looked healthy on its own page:
 * Re:Zero S4 spent a day with four wants at 7-9 failed attempts and nine
 * "fulfilled" wants whose files had moved, and `/manage/series/54` showed none
 * of it. Same detectors, same wording — just answerable for the title you are
 * actually looking at.
 *
 * `qbitOrphans` is deliberately absent: a torrent unknown to the ledger has no
 * series to be grouped under, so it belongs on the global page only.
 */
export interface SeriesHealth {
  ledgerOrphans: SourcingLedgerReport['ledgerOrphans']
  staleCompleted: SourcingLedgerReport['staleCompleted']
  sourcedWantsDeadTorrent: SourcingLedgerReport['sourcedWantsDeadTorrent']
  fulfilledWantsMissingFile: SourcingLedgerReport['fulfilledWantsMissingFile']
}

export async function seriesHealth(
  malId: number,
  opts: { live?: QbitTorrent[] | null } = {},
): Promise<SeriesHealth> {
  const report = await sourcingLedger({ live: opts.live })
  return {
    ledgerOrphans: report.ledgerOrphans.filter((r) => r.mal_id === malId),
    staleCompleted: report.staleCompleted.filter((r) => r.mal_id === malId),
    sourcedWantsDeadTorrent: report.sourcedWantsDeadTorrent.filter((r) => r.mal_id === malId),
    fulfilledWantsMissingFile: report.fulfilledWantsMissingFile.filter((r) => r.mal_id === malId),
  }
}

/** True when any of the four checks found something for this series. */
export function seriesHealthIsClean(h: SeriesHealth): boolean {
  return (
    h.ledgerOrphans.length === 0 &&
    h.staleCompleted.length === 0 &&
    h.sourcedWantsDeadTorrent.length === 0 &&
    h.fulfilledWantsMissingFile.length === 0
  )
}
