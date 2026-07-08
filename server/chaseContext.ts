// Orchestrates episode-chase inputs for a catalog series (cached air dates +
// download/library/on-site maps). Pure resolution lives in episodeChase.ts.

import {
  getCachedEpisodes,
  getSeriesById,
  listSeries,
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
} from './episodeChase.js'

export type { EpisodeChase }
export { toPublicChase }

function airInfosForSeries(series: SeriesRow): EpisodeAirInfo[] {
  return getCachedEpisodes(series.mal_id).map((e) => ({
    episode: e.number,
    title: e.title,
    aired: e.aired ?? null,
  }))
}

function chaseFromStatus(
  series: SeriesRow,
  status: SeriesDownloadStatus,
  libraryEpisodes: Set<number>,
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
  })
  return { airedCount, expectedForPipeline: expected, nextChase }
}

export async function buildSeriesChase(
  seriesId: number,
  opts: { includeLibrary?: boolean } = {},
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

  const { airedCount, expectedForPipeline, nextChase } = chaseFromStatus(
    series,
    status,
    libraryEpisodes,
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
    out.set(s.id, chaseFromStatus(s, status, new Set()).nextChase)
  }
  return out
}
