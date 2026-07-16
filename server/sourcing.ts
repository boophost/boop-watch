// Sourcing reconciliation: cross-checks the torrent ledger, the wants table,
// the per-file library ledger, and live qBittorrent, so nothing the flows
// queue can silently drift out of tracking. Read report + two idempotent
// fixers (backfill = adopt pre-ledger history; reconcile = safe corrections).

import fs from 'node:fs'
import path from 'node:path'
import {
  listSeries,
  listWants,
  listLibraryFiles,
  forgetLibraryFile,
  getTorrent,
  recordTorrentQueued,
  setTorrentStatus,
  recordTorrentOutcome,
  upsertWant,
  markWantSourced,
  updateWantStatus,
  getDb,
  type TorrentRow,
  type WantRow,
} from './db.js'
import { qbitConfigured, qbitList, parseTorrentTags, type QbitTorrent } from './qbit.js'

// qBittorrent is shared between prod and staging; each environment owns one
// category (QBIT_CATEGORY: prod 'anime', staging 'anime-dev'). Reconciliation
// must only look at THIS environment's slice, or prod's backfill would adopt
// dev's torrents into prod's ledger (and each env would report the other's
// torrents as orphans).
const ourCategory = () => process.env.QBIT_CATEGORY || 'anime'
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
  ledgerOrphans: { hash: string; name: string | null; status: string }[]
  /** Completed >24h ago and neither imported nor exhausted — the import flow is not consuming them. */
  staleCompleted: { hash: string; name: string | null; completed_at: string | null }[]
  /** Sourced wants whose torrent is gone/cleaned/failed — they will never fulfil. */
  sourcedWantsDeadTorrent: { want_id: number; mal_id: number; episode: number | null; torrent_hash: string | null; torrent_status: string | null }[]
  /** Fulfilled wants whose library file no longer exists on disk — the chase
   * renders these as "importing" forever unless reopened (phantom rows from a
   * DB clone, or a file deleted out-of-band). */
  fulfilledWantsMissingFile: { want_id: number; mal_id: number; episode: number | null; library_path: string | null }[]
}

export async function sourcingLedger(): Promise<SourcingLedgerReport> {
  const rows = allTorrentRows()
  const byHash = new Map(rows.map((r) => [r.hash, r]))
  const configured = qbitConfigured()
  let live: QbitTorrent[] = []
  if (configured) live = await qbitListOurs()
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
        .map((r) => ({ hash: r.hash, name: r.name, status: r.status }))
    : []

  const dayAgo = Date.now() - 24 * 3600_000
  const staleCompleted = rows
    .filter(
      (r) =>
        r.status === 'completed' &&
        r.completed_at != null &&
        new Date(r.completed_at + 'Z').getTime() < dayAgo,
    )
    .map((r) => ({ hash: r.hash, name: r.name, completed_at: r.completed_at }))

  const wants = listWants()
  const sourcedWantsDeadTorrent = wants
    .filter((w) => w.status === 'sourced')
    .map((w) => {
      const t = w.torrent_hash ? byHash.get(w.torrent_hash) : undefined
      const liveT = w.torrent_hash ? liveByHash.get(w.torrent_hash) : undefined
      const dead =
        !w.torrent_hash ||
        (!liveT && configured && (!t || LIVE_STATUSES.has(t.status))) ||
        (t != null && (t.status === 'failed' || t.status === 'cleaned' || t.status === 'superseded'))
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
  const root = process.env.LIBRARY_DIR ?? '/library'
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(root, p))
  const libByEp = new Map<string, string>()
  for (const f of listLibraryFiles()) {
    if (f.mal_id != null && f.episode != null) libByEp.set(`${f.mal_id}:${f.episode}`, f.path)
  }
  const offsetByMal = new Map(listSeries().map((s) => [s.mal_id, s.episode_offset ?? 0]))
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
  const seriesByMal = new Map(listSeries().map((s) => [s.mal_id, s]))

  let adoptedFromQbit = 0
  let adoptedFromLibrary = 0
  let wantsFulfilled = 0

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
  const seen = new Set<string>()
  for (const f of libFiles) {
    if (f.mal_id == null || f.episode == null) continue
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

  return { dryRun, adoptedFromQbit, adoptedFromLibrary, wantsFulfilled }
}

export interface ReconcileResult {
  dryRun: boolean
  /** live-status ledger rows with no qBit torrent → cleaned (imported) / failed (never completed). */
  orphanRowsClosed: number
  /** sourced wants pointing at dead torrents → reopened with an attempt recorded. */
  wantsReopened: number
  /** fulfilled wants whose file vanished → reopened; dead library_files rows dropped. */
  phantomFulfilledReopened: number
}

/** Apply the safe fixes for what `sourcingLedger` reports. */
export async function sourcingReconcile(dryRun: boolean): Promise<ReconcileResult> {
  const report = await sourcingLedger()
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
  const root = process.env.LIBRARY_DIR ?? '/library'
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

  return { dryRun, orphanRowsClosed, wantsReopened, phantomFulfilledReopened }
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
