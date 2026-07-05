// Assembles the download/availability status shown on the /manage series page:
// which qBittorrent torrents belong to this series (matched by title), their
// progress, and which episodes are already live on the public portal.

import { qbitConfigured, qbitList, type QbitTorrent } from './qbit.js'
import { getAllPortalItems } from './portalDb.js'
import { getSeriesById } from './db.js'

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

export async function getSeriesDownloadStatus(seriesId: number): Promise<SeriesDownloadStatus> {
  const series = getSeriesById(seriesId)
  const seriesTokens = series ? tokens(series.title) : []

  // Episodes already on the public portal, matched to this series by name.
  const siteEpisodes: Record<string, string> = {}
  for (const it of getAllPortalItems()) {
    if (it.type !== 'Episode' || it.index_number == null) continue
    if (overlap(it.series_name ?? it.name, seriesTokens) >= 0.5) {
      siteEpisodes[String(it.index_number)] = it.id
    }
  }

  if (!qbitConfigured()) {
    return { qbitConfigured: false, qbitError: null, torrents: [], siteEpisodes }
  }

  let raw: QbitTorrent[] = []
  let qbitError: string | null = null
  try {
    raw = await qbitList()
  } catch (e) {
    qbitError = e instanceof Error ? e.message : 'qBittorrent unavailable'
  }

  const torrents: SeriesDownload[] = raw
    .filter((t) => overlap(t.name, seriesTokens) >= 0.6)
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

  return { qbitConfigured: true, qbitError, torrents, siteEpisodes }
}
