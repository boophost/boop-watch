// Player stream metadata (audio/subtitle/quality tracks + sibling episodes),
// ported from the legacy /watch route's data layer. Subtitles are delivered as
// separate ASS via /api/sub and rendered client-side (JASSUB) — not burned in.
import type { JfItem, JfMediaStream } from './jellyfin.js'

const LANG_NAMES: Record<string, string> = {
  eng: 'English', jpn: 'Japanese', jap: 'Japanese', spa: 'Spanish', fre: 'French', fra: 'French',
  ger: 'German', deu: 'German', por: 'Portuguese', ita: 'Italian', kor: 'Korean', chi: 'Chinese',
  zho: 'Chinese', rus: 'Russian', ara: 'Arabic', vie: 'Vietnamese', tha: 'Thai', ind: 'Indonesian',
  und: 'Unknown',
}
const langName = (c?: string): string => (c ? (LANG_NAMES[String(c).toLowerCase()] || String(c).toUpperCase()) : 'Unknown')
const chLabel = (n?: number): string => (n === 1 ? 'Mono' : n === 2 ? 'Stereo' : n === 6 ? '5.1' : n === 8 ? '7.1' : n ? `${n}ch` : '')

// Server-side quality presets (resolution + bitrate cap). Auto = source-driven.
export const QUALITY_PRESETS = [
  { key: 'auto', label: 'Auto', h: 0, vb: 0 },
  { key: '1080', label: '1080p', h: 1080, vb: 8000000 },
  { key: '720', label: '720p', h: 720, vb: 4000000 },
  { key: '480', label: '480p', h: 480, vb: 1500000 },
  { key: '240', label: '240p', h: 240, vb: 600000 },
]

export interface AudioTrack { index: number; lang: string; label: string; detail: string; def: boolean }
export interface SubTrack { index: number; group: string }
export interface WatchEpisode { id: string; num: string; name: string; current: boolean }
// Intro/outro skip ranges (seconds), sourced from Jellyfin Media Segments.
export interface Segment { type: 'intro' | 'outro'; start: number; end: number }
export interface WatchData {
  id: string
  title: string
  epNum: string
  isEpisode: boolean
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

  const audioTracks: AudioTrack[] = streams.filter((s) => s.Type === 'Audio').map((s) => ({
    index: s.Index,
    lang: String(s.Language || '').toLowerCase(),
    label: langName(s.Language),
    detail: [String(s.Codec || '').toUpperCase(), chLabel(s.Channels)].filter(Boolean).join(' · '),
    def: !!s.IsDefault,
  }))
  const defAudio = (audioTracks.find((t) => t.def) || audioTracks[0] || {}).index

  // English text subtitles, condensed to "Full" dialogue tracks (one per release
  // group), dropping the redundant signs-only / CC / SDH / forced variants.
  const isTextSub = (s: JfMediaStream) => s.IsTextSubtitleStream
    || /^(ass|ssa|subrip|srt|webvtt|vtt|mov_text|text)$/i.test(s.Codec || '')
  const isEngSub = (s: JfMediaStream) => /^en/i.test(s.Language || '') || /\beng(lish)?\b/i.test(s.DisplayTitle || s.Title || '')
  const subCat = (s: JfMediaStream): string => {
    const t = `${s.Title || ''} ${s.DisplayTitle || ''}`.toLowerCase()
    if (s.IsForced || /forced/.test(t)) return 'forced'
    if (/sdh|deaf|hard of hearing|closed caption|\bcc\b/.test(t)) return 'cc'
    if (/(sign|song)/.test(t) && !/\bfull\b/.test(t)) return 'signs'
    return 'full'
  }
  const subGroup = (s: JfMediaStream): string => {
    const m = `${s.Title || ''} ${s.DisplayTitle || ''}`.match(/\[([^\]]+)\]/)
    return m ? m[1].trim() : ''
  }
  const engSubs = streams.filter((s) => s.Type === 'Subtitle' && isTextSub(s) && isEngSub(s))
  let subPool = engSubs.filter((s) => subCat(s) === 'full')
  if (!subPool.length) subPool = engSubs                       // fallback: whatever English we have
  const subs: SubTrack[] = subPool
    .sort((a, b) => {
      const ass = (/^(ass|ssa)$/i.test(b.Codec || '') ? 1 : 0) - (/^(ass|ssa)$/i.test(a.Codec || '') ? 1 : 0)
      return ass || a.Index - b.Index
    })
    .map((s) => ({ index: s.Index, group: subGroup(s) }))

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
