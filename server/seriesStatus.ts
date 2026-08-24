// One joined per-episode view of a series, for /manage/series/:id.
//
// The five facts about an episode live in five places that never meet:
//
//   wants          what we decided we need        (server/db.ts)
//   torrents       what we asked qBittorrent for  (server/db.ts + live qBit)
//   library_files  what we put on disk            (server/db.ts)
//   Jellyfin       what the media server indexed  (getSeriesLibraryMedia)
//   portal_items   what the public site can play  (server/portalDb.ts)
//
// Nothing joined them per series, so the page collapsed the last three into one
// word — "importing" — and an import that had genuinely succeeded but landed in
// a folder Jellyfin indexed as a *different* series was indistinguishable from
// one still in flight. That cost a day of Re:Zero S4 sitting at "importing"
// while every fact needed to explain it was already in the database.
//
// Episode numbering: the canonical key here is the **MAL per-cour** number, the
// one `wants` and the whole chase pipeline speak. `library_files` and Jellyfin
// both store *post-offset* numbers, so reaching into those applies
// `series.episode_offset` — the same convention matchSeriesDownloads() and
// sourcing.ts already use. Getting this backwards silently offsets a whole cour.
import fs from 'node:fs'
import path from 'node:path'
import {
  getSeriesById, getCachedEpisodes, listLibraryFiles, listWants,
  type LibraryFileRow, type SeriesRow, type WantRow, type TorrentRow,
} from './db.js'
import { getDb } from './db.js'
import { getAllPortalItems } from './portalDb.js'
import { sectionLibraryRoot } from './sections.js'
import { seriesLibraryDirs } from './libraryPaths.js'
import { seriesHealth, type SeriesHealth } from './sourcing.js'
import {
  matchSeriesDownloads, getSeriesLibraryMedia, resolveJfSeriesId,
  type EpisodeMedia, type SeriesDownload,
} from './downloads.js'
import { jfItem } from './jellyfin.js'
import { qbitConfigured, qbitList, type QbitTorrent } from './qbit.js'

/**
 * Where an episode has actually got to.
 *
 * The last three are what the old `ChaseState` collapsed into `importing` /
 * `ready`. Splitting them is the point of this module: `imported` (bytes are on
 * disk) is not `indexed` (Jellyfin knows about it) is not `on-portal` (the
 * public site can play it), and the failure that prompted all this lived
 * precisely in the gap between the first two.
 *
 * `ChaseState` in src/lib/chase.ts is deliberately left alone — the portal and
 * the series list depend on its wording. This vocabulary is admin-only.
 */
export type EpisodeStage =
  | 'unaired'
  | 'wanted'
  | 'searching'
  | 'downloading'
  | 'imported'
  | 'indexed'
  | 'on-portal'

export type EpisodeIssueCode =
  | 'stalled'
  | 'ghost-file'
  | 'unindexed'
  | 'off-portal'
  | 'dead-torrent'
  | 'audio-outlier'

export interface EpisodeIssue {
  code: EpisodeIssueCode
  /** One sentence, written for someone who did not read this file. */
  detail: string
}

export interface EpisodeStatus {
  /** MAL per-cour number — the canonical key. */
  episode: number
  /** The same episode in library/Jellyfin numbering (episode + offset). */
  libraryEpisode: number
  title: string | null
  airedAt: string | null
  want: {
    id: number
    status: WantRow['status']
    reason: string | null
    attempts: number
    lastAttemptAt: string | null
    nextAttemptAt: string | null
    note: string | null
  } | null
  torrent: {
    hash: string
    name: string | null
    status: TorrentRow['status']
    provider: string | null
    note: string | null
    /** Live qBittorrent state, when the torrent is still there. */
    liveState: string | null
    progress: number | null
  } | null
  file: {
    path: string
    sizeBytes: number | null
    method: string | null
    importedAt: string
    existsOnDisk: boolean
  } | null
  jellyfin: { itemId: string } | null
  portal: { itemId: string } | null
  media: EpisodeMedia | null
  stage: EpisodeStage
  issues: EpisodeIssue[]
}

export interface SeriesStatus {
  seriesId: number
  section: string
  malId: number | null
  seasonNumber: number | null
  episodeOffset: number
  episodes: EpisodeStatus[]
  /** Directories under the section library root that read as this series. More
   * than one means the library is split across folders. */
  libraryDirs: string[]
  health: SeriesHealth | null
  /** Torrents for this series that map to no episode — where orphans hide. */
  unmatchedTorrents: SeriesDownload[]
  qbitConfigured: boolean
  qbitError: string | null
}

function torrentRowsFor(malId: number): TorrentRow[] {
  return getDb().prepare('SELECT * FROM torrents WHERE mal_id = ?').all(malId) as TorrentRow[]
}

/**
 * The audio languages most of this season carries.
 *
 * A partially-dubbed season is normal and not worth flagging on its own; what
 * *is* worth flagging is the odd episode out, because that is invisible when
 * every row renders its own language pills independently and you have to read
 * nineteen of them to notice two are short. Requires at least three episodes
 * with media before it will call anything an outlier — below that there is no
 * "usual" to deviate from.
 */
function modalAudioLangs(medias: EpisodeMedia[]): Set<string> | null {
  const withAudio = medias.filter((m) => m.audio.length > 0)
  if (withAudio.length < 3) return null
  const tally = new Map<string, number>()
  for (const m of withAudio) {
    const key = [...new Set(m.audio.map((a) => a.lang))].sort().join('+')
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  let best = ''
  let bestN = 0
  for (const [k, n] of tally) if (n > bestN) { best = k; bestN = n }
  // Only trust it as a norm if it is actually the majority.
  if (bestN * 2 <= withAudio.length) return null
  return new Set(best.split('+').filter(Boolean))
}

export async function buildSeriesStatus(seriesId: number): Promise<SeriesStatus | null> {
  const series = getSeriesById(seriesId)
  if (!series) return null

  const offset = series.episode_offset ?? 0
  const season = series.tvdb_season ?? null
  const malId = series.mal_id ?? null

  // One qBittorrent call, shared by the download match and the health checks.
  // The page polls while a download is running, so a second call here would
  // double that load to say the same thing.
  let raw: QbitTorrent[] | null = null
  let qbitError: string | null = null
  const configured = qbitConfigured()
  if (configured) {
    try {
      raw = await qbitList()
    } catch (e) {
      qbitError = e instanceof Error ? e.message : 'qBittorrent unavailable'
    }
  }

  const portalItems = getAllPortalItems()
  const matched = matchSeriesDownloads(series, portalItems, raw, { configured, error: qbitError })

  // Jellyfin is a network call and is allowed to fail without taking the page
  // with it — a Jellyfin outage should read as "unknown", not as "no episodes".
  let media: EpisodeMedia[] = []
  let mediaOk = true
  try {
    media = await getSeriesLibraryMedia(seriesId)
  } catch {
    mediaOk = false
  }

  const libRoot = sectionLibraryRoot((series.section ?? 'anime') as 'anime' | 'tv' | 'movies')

  const health = malId != null ? await seriesHealth(malId, { live: raw }) : null

  // Index every source by its own numbering, then read them through `episode`.
  const wantByEp = new Map<number, WantRow>()
  if (malId != null) {
    for (const w of listWants()) {
      if (w.mal_id === malId && w.kind === 'episode' && w.episode != null) wantByEp.set(w.episode, w)
    }
  }
  const torrentRows = malId != null ? torrentRowsFor(malId) : []
  const torrentByEp = new Map<number, TorrentRow>()
  for (const t of torrentRows) {
    if (t.episode == null) continue
    const prev = torrentByEp.get(t.episode)
    // Newest wins: a replacement grab supersedes the one it replaced.
    if (!prev || String(t.queued_at) > String(prev.queued_at)) torrentByEp.set(t.episode, t)
  }
  const fileByLibEp = new Map<number, LibraryFileRow>()
  for (const f of listLibraryFiles()) {
    const mine = f.series_id === seriesId || (malId != null && f.mal_id === malId)
    if (!mine || f.episode == null) continue
    fileByLibEp.set(f.episode, f)
  }
  const mediaByLibEp = new Map<number, EpisodeMedia>()
  for (const m of media) if (m.episode != null) mediaByLibEp.set(m.episode, m)

  // Titles/air dates from the local cache only — no network. The page fetches
  // richer episode data separately; carrying these here is what lets /status be
  // read on its own (from a shell, from a test) and still make sense.
  const cached = new Map(
    (malId != null ? getCachedEpisodes(malId) : []).map((e) => [e.number, e]),
  )

  // Where the library actually lives, from both sides: the folders our ledger
  // wrote into, and the folder Jellyfin is reading the series from. When those
  // disagree the show is split in two and its new episodes never reach the
  // portal — invisible until now, and the whole reason this field exists.
  let jellyfinPath: string | null = null
  try {
    const jfId = await resolveJfSeriesId(series)
    if (jfId) jellyfinPath = (await jfItem(jfId, 'Path')).Path ?? null
  } catch {
    jellyfinPath = null
  }
  const libraryDirs = seriesLibraryDirs([...fileByLibEp.values()].map((f) => f.path), jellyfinPath)

  const liveByHash = new Map((raw ?? []).map((t) => [t.hash.toLowerCase(), t]))
  const norm = modalAudioLangs(media)
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.join(libRoot, p))

  // The episode universe: every number any source knows about, so an episode
  // that exists only as a want (never downloaded) still gets a row, and so does
  // a stray file for an episode the metadata provider has not listed yet.
  const numbers = new Set<number>()
  for (const n of wantByEp.keys()) numbers.add(n)
  for (const n of torrentByEp.keys()) numbers.add(n)
  for (const n of fileByLibEp.keys()) numbers.add(n - offset)
  for (const n of mediaByLibEp.keys()) numbers.add(n - offset)
  for (const n of cached.keys()) numbers.add(n)
  // Read the portal map by parsing its own keys rather than rebuilding them:
  // matchSeriesDownloads keys TV as `${parentIndexNumber}:${n}` and anime as a
  // bare `${n}`, and reconstructing that here would silently miss whenever a
  // Jellyfin season number disagrees with our `tvdb_season`.
  const portalByEp = new Map<number, string>()
  for (const [key, itemId] of Object.entries(matched.siteEpisodes)) {
    if (key === 'movie') continue
    const n = Number(key.includes(':') ? key.split(':')[1] : key)
    if (!Number.isFinite(n)) continue
    portalByEp.set(n, itemId)
    numbers.add(n)
  }

  const episodes: EpisodeStatus[] = [...numbers]
    .filter((n) => Number.isFinite(n) && n >= 1)
    .sort((a, b) => a - b)
    .map((episode) => {
      const libEp = episode + offset
      const want = wantByEp.get(episode) ?? null
      const trow = torrentByEp.get(episode) ?? null
      const frow = fileByLibEp.get(libEp) ?? null
      const m = mediaByLibEp.get(libEp) ?? null
      const portalId = portalByEp.get(episode) ?? null
      const liveT = trow ? liveByHash.get(trow.hash) ?? null : null
      const existsOnDisk = frow ? fs.existsSync(abs(frow.path)) : false

      const issues: EpisodeIssue[] = []

      if (want && want.status === 'open' && want.attempts >= 3) {
        issues.push({
          code: 'stalled',
          detail: `No release found after ${want.attempts} attempts${want.note ? ` — ${want.note}` : ''}.`,
        })
      }
      if (frow && !existsOnDisk) {
        issues.push({
          code: 'ghost-file',
          detail: `The ledger points at ${frow.path}, but there is no file there.`,
        })
      }
      // The one that would have caught the Re:Zero incident on sight.
      if (frow && existsOnDisk && !m && mediaOk) {
        issues.push({
          code: 'unindexed',
          detail: 'The file is on disk but Jellyfin has not indexed it — usually a folder Jellyfin reads as a different series.',
        })
      }
      if (m && !portalId) {
        issues.push({
          code: 'off-portal',
          detail: 'Jellyfin has this episode but it is not in the Public collection, so the portal cannot play it.',
        })
      }
      if (
        want && want.status === 'sourced' &&
        (!trow || ['failed', 'cleaned', 'superseded', 'exhausted'].includes(trow.status))
      ) {
        issues.push({
          code: 'dead-torrent',
          detail: `Sourced, but its download is ${trow ? trow.status : 'gone'} — it will never complete on its own.`,
        })
      }
      if (norm && m && m.audio.length > 0) {
        const langs = new Set(m.audio.map((a) => a.lang))
        const missing = [...norm].filter((l) => !langs.has(l))
        if (missing.length > 0) {
          issues.push({
            code: 'audio-outlier',
            detail: `Missing ${missing.join(', ')} audio that the rest of the season has.`,
          })
        }
      }

      // Furthest point reached wins; issues ride alongside rather than
      // overriding, so "on disk but not indexed" reads as exactly that instead
      // of masquerading as still-downloading.
      let stage: EpisodeStage
      if (portalId) stage = 'on-portal'
      else if (m) stage = 'indexed'
      else if (frow && existsOnDisk) stage = 'imported'
      else if (liveT || (trow && ['queued', 'downloading', 'completed'].includes(trow.status))) stage = 'downloading'
      else if (want && want.status === 'open') stage = want.attempts > 0 ? 'searching' : 'wanted'
      else if (want) stage = 'wanted'
      else stage = 'unaired'

      return {
        episode,
        libraryEpisode: libEp,
        title: cached.get(episode)?.title ?? null,
        airedAt: cached.get(episode)?.aired ?? null,
        want: want
          ? {
              id: want.id,
              status: want.status,
              reason: want.reason,
              attempts: want.attempts,
              lastAttemptAt: want.last_attempt_at,
              nextAttemptAt: want.next_attempt_at,
              note: want.note,
            }
          : null,
        torrent: trow
          ? {
              hash: trow.hash,
              name: trow.name,
              status: trow.status,
              provider: trow.provider,
              note: trow.note,
              liveState: liveT?.state ?? null,
              progress: liveT?.progress ?? null,
            }
          : null,
        file: frow
          ? {
              path: frow.path,
              sizeBytes: frow.size,
              method: frow.method,
              importedAt: frow.imported_at,
              existsOnDisk,
            }
          : null,
        jellyfin: m ? { itemId: m.id } : null,
        portal: portalId ? { itemId: portalId } : null,
        media: m,
        stage,
        issues,
      }
    })

  // Torrents qBittorrent is holding for this series that no episode claimed.
  const claimed = new Set(episodes.map((e) => e.torrent?.hash).filter(Boolean) as string[])
  const unmatchedTorrents = matched.torrents.filter((t) => !claimed.has(t.hash.toLowerCase()))

  return {
    seriesId,
    section: series.section ?? 'anime',
    malId,
    seasonNumber: season,
    episodeOffset: offset,
    episodes,
    libraryDirs,
    health,
    unmatchedTorrents,
    qbitConfigured: configured,
    qbitError,
  }
}

export type { SeriesRow }
