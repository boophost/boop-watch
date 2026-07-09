// Assembles the download/availability status shown on the /manage series page:
// which qBittorrent torrents belong to this series (matched by title), their
// progress, and which episodes are already live on the public portal.

import { qbitConfigured, qbitList, type QbitTorrent } from './qbit.js'
import { getAllPortalItems } from './portalDb.js'
import { getSeriesById } from './db.js'
import { jellyfinConfigured, jfJson, type JfItem, type JfMediaStream } from './jellyfin.js'

const norm = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const STOP = new Set([
  'the', 'a', 'an', 'of', 'no', 'to', 'wa', 'ga', 'season', 'part', 'ova', 'movie',
  '1080p', '720p', '480p', '2160p', 'batch', 'bd', 'bluray', 'web', 'dual', 'audio',
])

function tokens(s: string): string[] {
  return norm(s)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t))
}

/** Fraction of the series's distinctive tokens present in a candidate string. */
function overlap(candidate: string, seriesTokens: string[]): number {
  if (seriesTokens.length === 0) return 0
  const c = norm(candidate)
  return seriesTokens.filter((t) => c.includes(t)).length / seriesTokens.length
}

/**
 * Best token overlap of a candidate against any of the series' title variants
 * (romaji / English / Japanese). Release names use whichever title the group
 * preferred — e.g. a dual-audio "Frieren - Beyond Journey's End" release matches
 * on the English variant even though our catalog title is romaji "Sousou no
 * Frieren", which alone would score too low to show up.
 */
function bestOverlap(candidate: string, variantTokens: string[][]): number {
  let best = 0
  for (const toks of variantTokens) best = Math.max(best, overlap(candidate, toks))
  return best
}

function isBatch(name: string): boolean {
  return /\bbatch\b|\bcomplete(?:d)?\b|\bseason\b|\(\s*\d{1,4}\s*[-~]\s*\d{1,4}\s*\)/i.test(name)
}

function parseEpisode(name: string): number | null {
  if (/\(\s*\d{1,4}\s*[-~]\s*\d{1,4}\s*\)/.test(name)) return null
  let m = name.match(/\bS\d{1,2}\s*E(\d{1,4})\b/i)
  if (m) return Number(m[1])
  m = name.match(/\bEP?(\d{1,4})\b/i)
  if (m) return Number(m[1])
  m = name.match(/\s-\s(\d{1,4})(?:v\d)?\s*(?:\[|\(|$)/i)
  if (m) return Number(m[1])
  return null
}

/** Season from a release name ("S04E01", "Season 4"). Null when unmarked. */
function parseSeason(name: string): number | null {
  let m = name.match(/\bS(\d{1,2})\s*E\d{1,4}\b/i)
  if (m) return Number(m[1])
  m = name.match(/\bSeason\s*(\d{1,2})\b/i)
  if (m) return Number(m[1])
  m = name.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i)
  if (m) return Number(m[1])
  return null
}

export interface SeriesDownload {
  hash: string
  name: string
  state: string
  progress: number
  dlspeed: number
  size: number
  numSeeds: number
  eta: number
  isBatch: boolean
  episode: number | null
}

export interface SeriesDownloadStatus {
  qbitConfigured: boolean
  qbitError: string | null
  torrents: SeriesDownload[]
  // episode number -> portal watch id (episode is live on the public site)
  siteEpisodes: Record<string, string>
  // True when the qBittorrent query was skipped because every expected episode
  // is already on site — the pipeline is done, so torrent state is moot.
  qbitSkipped?: boolean
  // Jellyfin Series id for the public portal's /series/:id page, when this
  // catalog row is actually on the Public collection — null otherwise.
  portalSeriesId: string | null
}

function variantTokensForSeries(series: {
  title: string
  title_english?: string | null
  title_japanese?: string | null
}): string[][] {
  return [series.title, series.title_english, series.title_japanese]
    .filter((t): t is string => !!t)
    .map(tokens)
    .filter((t) => t.length > 0)
}

/** Portal-scoped Series match only (mal_id, then title overlap) — no live
 * Jellyfin fallback, since a series absent from the Public collection has no
 * public page to link to. */
function resolvePortalSeriesId(
  series: {
    mal_id?: number | null
    title: string
    title_english?: string | null
    title_japanese?: string | null
  },
  portalItems: ReturnType<typeof getAllPortalItems>,
): string | null {
  const variantTokens = variantTokensForSeries(series)
  const seriesItems = portalItems.filter((it) => it.type === 'Series')
  if (series.mal_id != null) {
    const byMal = seriesItems.find((it) => it.mal_id === series.mal_id)
    if (byMal) return byMal.id
  }
  let best = 0
  let bestId: string | null = null
  for (const it of seriesItems) {
    const s = bestOverlap(it.name, variantTokens)
    if (s > best && s >= 0.5) {
      best = s
      bestId = it.id
    }
  }
  return bestId
}

/** Match site episodes + torrents for one series against shared portal/qBit snapshots.
 * When `tvdb_season` is set (a cour in a multi-season franchise), only that JF
 * season's episodes count as on-site — IndexNumber alone collides across seasons. */
export function matchSeriesDownloads(
  series: {
    mal_id?: number | null
    title: string
    title_english?: string | null
    title_japanese?: string | null
    tvdb_season?: number | null
  },
  portalItems: ReturnType<typeof getAllPortalItems>,
  rawTorrents: QbitTorrent[] | null,
  qbit: { configured: boolean; error: string | null },
): SeriesDownloadStatus {
  const variantTokens = variantTokensForSeries(series)
  const season = series.tvdb_season ?? null
  const siteEpisodes: Record<string, string> = {}
  for (const it of portalItems) {
    if (it.type !== 'Episode' || it.index_number == null) continue
    if (season != null && it.parent_index_number !== season) continue
    if (bestOverlap(it.series_name ?? it.name, variantTokens) >= 0.5) {
      siteEpisodes[String(it.index_number)] = it.id
    }
  }
  const portalSeriesId = resolvePortalSeriesId(series, portalItems)

  if (!qbit.configured || rawTorrents == null) {
    return {
      qbitConfigured: qbit.configured,
      qbitError: qbit.error,
      torrents: [],
      siteEpisodes,
      portalSeriesId,
    }
  }

  const torrents: SeriesDownload[] = rawTorrents
    .filter((t) => {
      if (bestOverlap(t.name, variantTokens) < 0.6) return false
      // Cour rows: drop releases tagged for a different season (S03 vs S04).
      if (season != null) {
        const s = parseSeason(t.name)
        if (s != null && s !== season) return false
      }
      return true
    })
    .map((t) => ({
      hash: t.hash,
      name: t.name,
      state: t.state,
      progress: t.progress,
      dlspeed: t.dlspeed,
      size: t.size,
      numSeeds: t.num_seeds,
      eta: t.eta,
      isBatch: isBatch(t.name),
      episode: parseEpisode(t.name),
    }))
    .sort((a, b) => b.progress - a.progress)

  return { qbitConfigured: true, qbitError: qbit.error, torrents, siteEpisodes, portalSeriesId }
}

export async function getSeriesDownloadStatus(
  seriesId: number,
  opts: {
    /** Skip the (slow while busy) qBittorrent query — the caller has already
     * determined nothing is chase-worthy right now (e.g. every episode is on
     * site, or the next one isn't due yet), so the portal match alone answers
     * everything callers need. */
    skipQbit?: boolean
  } = {},
): Promise<SeriesDownloadStatus> {
  const series = getSeriesById(seriesId)
  const portalItems = getAllPortalItems()
  if (!series) {
    return {
      qbitConfigured: qbitConfigured(),
      qbitError: null,
      torrents: [],
      siteEpisodes: {},
      portalSeriesId: null,
    }
  }

  if (!qbitConfigured()) {
    return matchSeriesDownloads(series, portalItems, null, { configured: false, error: null })
  }

  if (opts.skipQbit) {
    const stub = matchSeriesDownloads(series, portalItems, null, { configured: true, error: null })
    return { ...stub, torrents: [], qbitSkipped: true }
  }

  let raw: QbitTorrent[] = []
  let qbitError: string | null = null
  try {
    raw = await qbitList()
  } catch (e) {
    qbitError = e instanceof Error ? e.message : 'qBittorrent unavailable'
  }

  return matchSeriesDownloads(series, portalItems, raw, { configured: true, error: qbitError })
}

/** One portal scan + one qBit list, then per-series matches (for list chase chips). */
export async function getSeriesDownloadStatusBatch(
  seriesList: Array<{
    id: number
    title: string
    title_english?: string | null
    title_japanese?: string | null
    tvdb_season?: number | null
  }>,
): Promise<Map<number, SeriesDownloadStatus>> {
  const portalItems = getAllPortalItems()
  const out = new Map<number, SeriesDownloadStatus>()

  let raw: QbitTorrent[] | null = null
  let qbitError: string | null = null
  const configured = qbitConfigured()
  if (configured) {
    try {
      raw = await qbitList()
    } catch (e) {
      qbitError = e instanceof Error ? e.message : 'qBittorrent unavailable'
      raw = []
    }
  }

  for (const series of seriesList) {
    out.set(
      series.id,
      matchSeriesDownloads(series, portalItems, raw, { configured, error: qbitError }),
    )
  }
  return out
}

// ── Per-episode library media facts (what's actually on the server) ──────────
// Distinct from the qBittorrent download list above: this reflects the *files in
// the library* (after import/mux), so the manage page shows real codecs/audio.

const LANG_NAMES: Record<string, string> = {
  eng: 'English', jpn: 'Japanese', jap: 'Japanese', spa: 'Spanish', fre: 'French',
  ger: 'German', por: 'Portuguese', ita: 'Italian', kor: 'Korean', chi: 'Chinese',
  zho: 'Chinese', rus: 'Russian', ara: 'Arabic', und: 'Unknown',
}
const langLabel = (c?: string): string =>
  c ? (LANG_NAMES[c.toLowerCase()] || c.toUpperCase()) : 'Unknown'
const chLabel = (n?: number): string =>
  n === 1 ? 'Mono' : n === 2 ? 'Stereo' : n === 6 ? '5.1' : n === 8 ? '7.1' : n ? `${n}ch` : ''
// Height → a familiar resolution label.
function resLabel(h?: number, w?: number): string {
  if (!h) return ''
  if (h >= 2000) return '4K'
  if (h >= 1000) return '1080p'
  if (h >= 700) return '720p'
  if (h >= 500) return '576p'
  if (h >= 380) return '480p'
  return w && h ? `${w}×${h}` : `${h}p`
}

export interface EpisodeAudio { lang: string; label: string; codec: string; channels: string; def: boolean }
export interface EpisodeMedia {
  id: string
  episode: number | null
  resolution: string
  videoCodec: string
  audio: EpisodeAudio[]
  subLangs: string[]
  sizeBytes: number | null
  container: string
  runtimeMin: number | null
}

/** Resolve a Jellyfin Series id for a catalog row. Prefer portal (mal_id / title),
 * then fall back to a Jellyfin library search — needed when the show is in the
 * media library but not (yet) in the Public collection / portal cache. */
async function resolveJfSeriesId(series: {
  mal_id: number
  title: string
  title_english?: string | null
  title_japanese?: string | null
}): Promise<string | null> {
  const jfSeriesId = resolvePortalSeriesId(series, getAllPortalItems())
  if (jfSeriesId) return jfSeriesId

  // Not on the public portal — search the full Jellyfin library by distinctive
  // title tokens (same idea as sink.jellyfin-collection's findJfItemByName).
  const variantTokens = variantTokensForSeries(series)
  const wanted = variantTokens.flat()
  const searchTerm = [...wanted].sort((a, b) => b.length - a.length)[0]
  if (!searchTerm) return null
  try {
    const res = await jfJson<{ Items?: JfItem[] }>('/Items', {
      Recursive: 'true',
      IncludeItemTypes: 'Series',
      SearchTerm: searchTerm,
      Limit: 25,
    })
    let best: { id: string; score: number } | null = null
    for (const it of res.Items ?? []) {
      const s = bestOverlap(it.Name ?? '', variantTokens)
      if (!best || s > best.score) best = { id: it.Id, score: s }
    }
    return best && best.score >= 0.5 ? best.id : null
  } catch {
    return null
  }
}

/** Media facts for every library episode of a series, keyed for the manage page.
 * Sourced from Jellyfin (one /Shows/{id}/Episodes call with stream fields). */
export async function getSeriesLibraryMedia(seriesId: number): Promise<EpisodeMedia[]> {
  if (!jellyfinConfigured) return []
  const series = getSeriesById(seriesId)
  if (!series) return []

  const jfSeriesId = await resolveJfSeriesId(series)
  if (!jfSeriesId) return []

  let episodes: JfItem[] = []
  try {
    const r = await jfJson<{ Items?: JfItem[] }>(`/Shows/${jfSeriesId}/Episodes`, {
      Fields: 'MediaStreams,MediaSources',
    })
    episodes = r.Items ?? []
  } catch {
    return []
  }

  // Multi-season franchise: a cour catalog row (tvdb_season set) only wants that
  // season's episodes — IndexNumber alone collides across seasons (S1E1 vs S4E1).
  const season = series.tvdb_season
  if (season != null) {
    episodes = episodes.filter((ep) => ep.ParentIndexNumber === season)
  }

  const out: EpisodeMedia[] = episodes.map((ep) => {
    const source = ep.MediaSources?.[0]
    const streams: JfMediaStream[] = ep.MediaStreams || source?.MediaStreams || []
    const video = streams.find((s) => s.Type === 'Video')
    const audio = streams
      .filter((s) => s.Type === 'Audio')
      .map((s) => ({
        lang: (s.Language || '').toLowerCase(),
        label: langLabel(s.Language),
        codec: (s.Codec || '').toUpperCase(),
        channels: chLabel(s.Channels),
        def: !!s.IsDefault,
      }))
    const subLangs = [
      ...new Set(
        streams
          .filter((s) => s.Type === 'Subtitle')
          .map((s) => langLabel(s.Language))
          .filter(Boolean),
      ),
    ]
    return {
      id: ep.Id,
      episode: ep.IndexNumber ?? null,
      resolution: resLabel(video?.Height, video?.Width),
      videoCodec: (video?.Codec || '').toUpperCase(),
      audio,
      subLangs,
      sizeBytes: source?.Size ?? null,
      container: (source?.Container || '').toUpperCase(),
      runtimeMin: ep.RunTimeTicks ? Math.round(ep.RunTimeTicks / 600000000) : null,
    }
  })
  out.sort((a, b) => (a.episode ?? 1e9) - (b.episode ?? 1e9))
  return out
}
