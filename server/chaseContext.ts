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
  type SeriesDownloadStatus,
} from './downloads.js'
import {
  resolveExpected,
  resolveNextChase,
  toPublicChase,
  type EpisodeAirInfo,
  type EpisodeChase,
  type MalBroadcast,
} from './episodeChase.js'
import { fetchAnimeFull } from './jikan.js'

export type { EpisodeChase }
export { toPublicChase }

function airInfosForSeries(series: SeriesRow): EpisodeAirInfo[] {
  return getCachedEpisodes(series.mal_id).map((e) => ({
    episode: e.number,
    title: e.title,
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
  const nextChase = resolveNextChase({
    episodes: airInfos,
    siteEpisodes: status.siteEpisodes,
    libraryEpisodes,
    torrents: status.torrents,
    malEpisodes: series.episodes,
    broadcast: broadcast ?? parseStoredBroadcast(series.broadcast),
  })
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
      const mal = await fetchAnimeFull(series.mal_id)
      const bc = mal.broadcast ?? null
      const serialized = serializeBroadcast(bc)
      if (serialized && serialized !== series.broadcast) {
        try {
          upsertSeriesMetadata(
            { mal_id: series.mal_id, title: series.title },
            {
              broadcast: serialized,
              ...(typeof mal.episodes === 'number' && mal.episodes > 0
                ? { episodes: mal.episodes }
                : {}),
              ...(mal.status ? { status: mal.status } : {}),
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
    }
  }

  const status = await getSeriesDownloadStatus(seriesId)
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
