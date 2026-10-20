// Player stream metadata (audio/subtitle/quality tracks + sibling episodes),
// ported from the legacy /watch route's data layer. Subtitles are delivered as
// separate ASS via /api/sub and rendered client-side (JASSUB) — not burned in.
import type { JfItem, JfMediaStream } from './jellyfin.js'
import { buildAudioTracks, buildSubTracks, type AudioTrack, type SubTrack } from './watchTracks.js'
export type { AudioTrack, SubTrack }

// Server-side quality presets (resolution + bitrate cap). Auto = source-driven.
export const QUALITY_PRESETS = [
  { key: 'auto', label: 'Auto', h: 0, vb: 0 },
  { key: '1080', label: '1080p', h: 1080, vb: 8000000 },
  { key: '720', label: '720p', h: 720, vb: 4000000 },
  { key: '480', label: '480p', h: 480, vb: 1500000 },
  { key: '240', label: '240p', h: 240, vb: 600000 },
]

export interface WatchEpisode { id: string; num: string; name: string; current: boolean }
// Intro/outro skip ranges (seconds), sourced from Jellyfin Media Segments.
export interface Segment { type: 'intro' | 'outro'; start: number; end: number }
export interface WatchData {
  id: string
  title: string
  epNum: string
  isEpisode: boolean
  /** Parent series + season for episodes (the OST widget's themes key). */
  seriesId: string | null
  season: number | null
  back: { href: string; label: string }
  audio: { tracks: AudioTrack[]; default: number | null }
  subs: SubTrack[]
  quality: typeof QUALITY_PRESETS
  episodes: WatchEpisode[]
  nextId: string | null
  segments: Segment[]
}

const epLabel = (ep: JfItem): string =>
  (ep.ParentIndexNumber != null && ep.IndexNumber != null)
    ? `S${ep.ParentIndexNumber}·E${ep.IndexNumber}`
    : (ep.IndexNumber != null ? `E${ep.IndexNumber}` : '·')

export function buildWatchData(id: string, item: JfItem, siblings: JfItem[], segments: Segment[] = []): WatchData {
  const title = item.Name || 'Now playing'
  const epNum = (item.ParentIndexNumber != null && item.IndexNumber != null)
    ? `S${item.ParentIndexNumber}·E${item.IndexNumber}` : ''
  const isEpisode = item.Type === 'Episode' && !!item.SeriesId

  const streams: JfMediaStream[] = item.MediaStreams
    || (item.MediaSources && item.MediaSources[0] && item.MediaSources[0].MediaStreams) || []

  const audioTracks = buildAudioTracks(streams)
  const defAudio = (audioTracks.find((t) => t.def) || audioTracks[0] || {}).index
  const subs = buildSubTracks(streams)

  const episodes: WatchEpisode[] = siblings.map((ep) => ({
    id: ep.Id, num: epLabel(ep), name: ep.Name || 'Episode', current: ep.Id === id,
  }))
  const curIdx = siblings.findIndex((ep) => ep.Id === id)
  const nextId = curIdx >= 0 && siblings[curIdx + 1] ? siblings[curIdx + 1].Id : null

  return {
    id,
    title,
    epNum,
    isEpisode,
    seriesId: isEpisode ? item.SeriesId ?? null : null,
    season: isEpisode ? item.ParentIndexNumber ?? null : null,
    back: isEpisode
      ? { href: `/series/${item.SeriesId}`, label: item.SeriesName || 'Series' }
      : { href: '/', label: 'All titles' },
    audio: { tracks: audioTracks, default: defAudio == null ? null : defAudio },
    subs,
    quality: QUALITY_PRESETS,
    episodes,
    nextId,
    segments,
  }
}
