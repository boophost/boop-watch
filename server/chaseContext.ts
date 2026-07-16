// Orchestrates episode-chase inputs for a catalog series (cached air dates +
// download/library/on-site maps). Pure resolution lives in episodeChase.ts.

import {
  getCachedEpisodes,
  getSeriesById,
  listSeries,
  upsertSeriesMetadata,
  type SeriesRow,
} from './db.js'
import {
  getSeriesDownloadStatus,
  getSeriesDownloadStatusBatch,
  getSeriesLibraryMedia,
  matchSeriesDownloads,
  type SeriesDownloadStatus,
} from './downloads.js'
import { getAllPortalItems } from './portalDb.js'
import {
  applyWantState,
  resolveChaseTarget,
  resolveExpected,
  resolveNextChase,
  toPublicChase,
  type EpisodeAirInfo,
  type EpisodeChase,
  type MalBroadcast,
} from './episodeChase.js'
import { isProperTitle } from './episodes.js'
import { wantForEpisode } from './sourcing.js'
import { fetchAnimeFull } from './jikan.js'
import { fetchAniListMedia } from './anilist.js'

export type { EpisodeChase }
export { toPublicChase }

function airInfosForSeries(series: SeriesRow): EpisodeAirInfo[] {
  return getCachedEpisodes(series.mal_id).map((e) => ({
    episode: e.number,
    // A provisional title is release residue, not a name worth chasing with.
    title: isProperTitle(e.title, e.title_source) ? e.title : null,
    aired: e.aired ?? null,
  }))
}

export function parseStoredBroadcast(raw: string | null | undefined): MalBroadcast | null {
  if (!raw) return null
  try {
    const j = JSON.parse(raw) as MalBroadcast
    if (!j || typeof j !== 'object') return null
    return j
  } catch {
    return null
  }
}

export function serializeBroadcast(bc: MalBroadcast | null | undefined): string | null {
  if (!bc) return null
  if (!bc.day && !bc.time && !bc.string) return null
  return JSON.stringify({
    day: bc.day ?? null,
    time: bc.time ?? null,
    timezone: bc.timezone ?? null,
    string: bc.string ?? null,
  })
}

function chaseFromStatus(
  series: SeriesRow,
  status: SeriesDownloadStatus,
  libraryEpisodes: Set<number>,
  broadcast?: MalBroadcast | null,
): {
  airedCount: number
  expectedForPipeline: number | null
  nextChase: EpisodeChase | null
} {
  const airInfos = airInfosForSeries(series)
  const { airedCount, expected } = resolveExpected(series.episodes, airInfos)
  const derived = resolveNextChase({
    episodes: airInfos,
    siteEpisodes: status.siteEpisodes,
    libraryEpisodes,
    torrents: status.torrents,
    malEpisodes: series.episodes,
    broadcast: broadcast ?? parseStoredBroadcast(series.broadcast),
  })
  // Persisted sourcing state wins over pure derivation: a want row knows
  // whether the episode is being retried (and when next), not just whether a
  // torrent happens to be visible in qBittorrent right now.
  const wantState = derived ? wantForEpisode(series.mal_id, derived.episode) : null
  const nextChase = applyWantState(derived, wantState?.want ?? null, wantState?.torrent ?? null)
  return { airedCount, expectedForPipeline: expected, nextChase }
}

function withBudget<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return p
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

/** Ensure we have a broadcast blob for airing seasons that need an estimate. */
async function ensureBroadcast(
  series: SeriesRow,
  opts: { budgetMs?: number } = {},
): Promise<MalBroadcast | null> {
  const existing = parseStoredBroadcast(series.broadcast)
  if (existing?.day && existing?.time) return existing

  // Only hit Jikan when we might need an estimate (airing / unknown total).
  const status = (series.status || '').toLowerCase()
  const maybeAiring =
    status.includes('air') || !series.episodes || series.episodes <= 0 || !existing
  if (!maybeAiring && existing) return existing

  const fetchAndPersist = async (): Promise<MalBroadcast | null> => {
    try {
      // AniList-primary (current, auth-free); its next-airing timestamp yields
      // the weekly broadcast slot. Fall back to Jikan only if AniList can't answer.
      const al = await fetchAniListMedia(series.mal_id)
      const bc: MalBroadcast | null = al
        ? al.broadcast
        : ((await fetchAnimeFull(series.mal_id)).broadcast ?? null)
      const episodes = al?.totalEpisodes ?? null
      const status = al?.status ?? null
      const serialized = serializeBroadcast(bc)
      if (serialized && serialized !== series.broadcast) {
        try {
          upsertSeriesMetadata(
            { mal_id: series.mal_id, title: series.title },
            {
              broadcast: serialized,
              ...(typeof episodes === 'number' && episodes > 0 ? { episodes } : {}),
              ...(status ? { status } : {}),
            },
          )
        } catch (e) {
          console.error('chase: failed to persist broadcast —', e)
        }
      }
      return bc
    } catch (e) {
      console.error('chase: broadcast fetch failed —', e)
      return existing
    }
  }

  const budgetMs = opts.budgetMs ?? 0
  if (budgetMs > 0) {
    // Race a budget; the underlying fetch keeps running so the next request
    // can hit a warm cache — don't start a second fetch.
    return withBudget(fetchAndPersist(), budgetMs, existing)
  }
  return fetchAndPersist()
}

export async function buildSeriesChase(
  seriesId: number,
  opts: { includeLibrary?: boolean; budgetMs?: number } = {},
): Promise<{
  airedCount: number
  expectedForPipeline: number | null
  nextChase: EpisodeChase | null
  siteEpisodes: Record<string, string>
  torrents: SeriesDownloadStatus['torrents']
  qbitConfigured: boolean
  qbitError: string | null
  qbitSkipped?: boolean
  portalSeriesId: string | null
}> {
  const series = getSeriesById(seriesId)
  if (!series) {
    return {
      airedCount: 0,
      expectedForPipeline: null,
      nextChase: null,
      siteEpisodes: {},
      torrents: [],
      qbitConfigured: false,
      qbitError: null,
      portalSeriesId: null,
    }
  }

  // Whether there's a due chase target is derivable from the local episode
  // cache + portal match alone (no qBit needed), so the status fetch can skip
  // the (slow while busy) qBittorrent query when nothing is chase-worthy —
  // but only then: a cached episode with no MAL air date (e.g. a mis-totaled
  // season) can still be a legitimate, currently-downloading target, so the
  // gate must check the actual next-chase target, not just a raw episode count.
  const airInfos = airInfosForSeries(series)
  const siteStub = matchSeriesDownloads(series, getAllPortalItems(), null, {
    configured: true,
    error: null,
  })
  const target = resolveChaseTarget({
    episodes: airInfos,
    siteEpisodes: siteStub.siteEpisodes,
    malEpisodes: series.episodes,
    broadcast: parseStoredBroadcast(series.broadcast),
  })
  // A persisted open want means nothing is queued — qBit can add nothing, so
  // skip its (slow while busy) query too. Only a sourced want (or no want row
  // at all, the pre-wants fallback) still needs live download progress.
  const targetWant = target?.due ? wantForEpisode(series.mal_id, target.episode) : null
  const skipQbit = !target || !target.due || targetWant?.want.status === 'open'
  const status = await getSeriesDownloadStatus(seriesId, { skipQbit })
  let libraryEpisodes = new Set<number>()
  if (opts.includeLibrary !== false) {
    try {
      const lib = await getSeriesLibraryMedia(seriesId)
      libraryEpisodes = new Set(
        lib.map((e) => e.episode).filter((n): n is number => n != null),
      )
    } catch {
      /* library optional for chase */
    }
  }

  // Fetch broadcast when the next chase would otherwise lack an air date.
  let broadcast = parseStoredBroadcast(series.broadcast)
  const prelim = chaseFromStatus(series, status, libraryEpisodes, broadcast)
  if (prelim.nextChase && !prelim.nextChase.airsAt) {
    broadcast = await ensureBroadcast(series, {
      budgetMs: opts.budgetMs,
    })
  }

  const { airedCount, expectedForPipeline, nextChase } = chaseFromStatus(
    series,
    status,
    libraryEpisodes,
    broadcast,
  )

  return {
    airedCount,
    expectedForPipeline,
    nextChase,
    siteEpisodes: status.siteEpisodes,
    torrents: status.torrents,
    qbitConfigured: status.qbitConfigured,
    qbitError: status.qbitError,
    qbitSkipped: status.qbitSkipped,
    portalSeriesId: status.portalSeriesId,
  }
}

/** List chips: one qBit/portal pass; skip series with no episode cache. */
export async function buildSeriesListChases(
  seriesList: SeriesRow[] = listSeries(),
): Promise<Map<number, EpisodeChase | null>> {
  const withCache = seriesList.filter((s) => getCachedEpisodes(s.mal_id).length > 0)
  const statuses = await getSeriesDownloadStatusBatch(withCache)
  const out = new Map<number, EpisodeChase | null>()
  for (const s of seriesList) {
    if (!statuses.has(s.id)) {
      out.set(s.id, null)
      continue
    }
    const status = statuses.get(s.id)!
    // List path uses stored broadcast only (no per-row Jikan fetch).
    out.set(s.id, chaseFromStatus(s, status, new Set()).nextChase)
  }
  return out
}
