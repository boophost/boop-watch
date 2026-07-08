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

/** Match site episodes + torrents for one series against shared portal/qBit snapshots. */
export function matchSeriesDownloads(
  series: { title: string; title_english?: string | null; title_japanese?: string | null },
  portalItems: ReturnType<typeof getAllPortalItems>,
  rawTorrents: QbitTorrent[] | null,
  qbit: { configured: boolean; error: string | null },
): SeriesDownloadStatus {
  const variantTokens = variantTokensForSeries(series)
  const siteEpisodes: Record<string, string> = {}
  for (const it of portalItems) {
    if (it.type !== 'Episode' || it.index_number == null) continue
    if (bestOverlap(it.series_name ?? it.name, variantTokens) >= 0.5) {
      siteEpisodes[String(it.index_number)] = it.id
    }
  }

  if (!qbit.configured || rawTorrents == null) {
    return { qbitConfigured: qbit.configured, qbitError: qbit.error, torrents: [], siteEpisodes }
  }

  const torrents: SeriesDownload[] = rawTorrents
    .filter((t) => bestOverlap(t.name, variantTokens) >= 0.6)
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

  return { qbitConfigured: true, qbitError: qbit.error, torrents, siteEpisodes }
}

export async function getSeriesDownloadStatus(seriesId: number): Promise<SeriesDownloadStatus> {
  const series = getSeriesById(seriesId)
  const portalItems = getAllPortalItems()
  if (!series) {
    return { qbitConfigured: qbitConfigured(), qbitError: null, torrents: [], siteEpisodes: {} }
  }

  if (!qbitConfigured()) {
    return matchSeriesDownloads(series, portalItems, null, { configured: false, error: null })
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
  seriesList: Array<{ id: number; title: string; title_english?: string | null; title_japanese?: string | null }>,
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

/** Media facts for every library episode of a series, keyed for the manage page.
 * Sourced from Jellyfin (one /Shows/{id}/Episodes call with stream fields). */
export async function getSeriesLibraryMedia(seriesId: number): Promise<EpisodeMedia[]> {
  if (!jellyfinConfigured) return []
  const series = getSeriesById(seriesId)
  if (!series) return []

  // Find the Jellyfin series id: prefer the catalogued portal Series item
  // (mal_id-tagged by the sync), else the best title-token match.
  const variantTokens = [series.title, series.title_english, series.title_japanese]
    .filter((t): t is string => !!t)
    .map(tokens)
    .filter((t) => t.length > 0)
  const seriesItems = getAllPortalItems().filter((it) => it.type === 'Series')
  let jfSeriesId =
    seriesItems.find((it) => it.mal_id != null && it.mal_id === series.mal_id)?.id ?? null
  if (!jfSeriesId) {
    let best = 0
    for (const it of seriesItems) {
      const s = bestOverlap(it.name, variantTokens)
      if (s > best && s >= 0.5) { best = s; jfSeriesId = it.id }
    }
  }
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
