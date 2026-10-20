// Audio + subtitle menu entries for the watch page, built from Jellyfin media
// streams. Kept separate from watch.ts so scripts/verify-watch-tracks.mjs can
// exercise it without the rest of the server.
import type { JfMediaStream } from './jellyfin.js'

const LANG_NAMES: Record<string, string> = {
  eng: 'English', jpn: 'Japanese', jap: 'Japanese', spa: 'Spanish', fre: 'French', fra: 'French',
  ger: 'German', deu: 'German', por: 'Portuguese', ita: 'Italian', kor: 'Korean', chi: 'Chinese',
  zho: 'Chinese', rus: 'Russian', ara: 'Arabic', vie: 'Vietnamese', tha: 'Thai', ind: 'Indonesian',
  und: 'Unknown',
}
export const langName = (c?: string): string => (c ? (LANG_NAMES[String(c).toLowerCase()] || String(c).toUpperCase()) : 'Unknown')
const chLabel = (n?: number): string => (n === 1 ? 'Mono' : n === 2 ? 'Stereo' : n === 6 ? '5.1' : n === 8 ? '7.1' : n ? `${n}ch` : '')

export interface AudioTrack { index: number; lang: string; label: string; detail: string; def: boolean }
// `sel` is a stable, cross-episode selector for remembering the sub choice: the
// media-stream `index` shuffles between episodes, so we key on the release group
// (consistent within a season) and fall back to the track's ordinal position.
// `alts` are older selectors that still resolve to this track (the pre-collapse
// scheme, plus the selectors of duplicates folded into it), so remembered
// choices survive the collapse.
export interface SubTrack { index: number; group: string; sel: string; alts: string[]; label: string; detail: string }

// ---- audio ---------------------------------------------------------------
// Label each track from its stream Title (what actually differs between
// same-language tracks: composer, dub, commentary) minus any redundant language
// prefix. Codec/channels are only the label when there is no usable title.
const stripLangPrefix = (title: string, lang: string): string => {
  const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const names = [langName(lang), lang].filter(Boolean).map(esc)
  const re = new RegExp(`^[\\[(]?\\s*(?:${[...names, 'eng(?:lish)?', 'jpn|jap(?:anese)?'].join('|')})\\s*[\\])]?\\s*(?:[-–—:|/,.]+\\s*|\\s+(?=\\S)|$)`, 'i')
  let t = title.trim()
  for (let i = 0; i < 2; i++) t = t.replace(re, '').trim()
  t = t.replace(/^\((.*)\)$/, '$1').trim()
  return t
}
// A title that only restates codec/layout carries no extra information.
const isTechOnly = (t: string): boolean =>
  !t.replace(/\b(ac-?3|e-?ac-?3|dts(?:-?hd)?(?: ma)?|aac|flac|opus|truehd|atmos|mp3|pcm|stereo|mono|surround|\d(?:\.\d)?\s*ch|\d\.\d|audio|track|\d+)\b/gi, '').replace(/[\s\-–—:|/,.()[\]]/g, '')

export function buildAudioTracks(streams: JfMediaStream[]): AudioTrack[] {
  const raw = streams.filter((s) => s.Type === 'Audio').map((s) => {
    const lang = String(s.Language || '').toLowerCase()
    const name = langName(s.Language)
    let title = stripLangPrefix(String(s.Title || ''), lang)
    if (isTechOnly(title)) title = ''
    const ch = chLabel(s.Channels)
    const tech = [String(s.Codec || '').toUpperCase(), ch].filter(Boolean).join(' · ')
    return {
      index: s.Index, lang, def: !!s.IsDefault,
      label: title ? `${name}: ${title}` : name,
      detail: title ? ch : tech,
    }
  })
  // Group by language (first-appearance order), stream order within a group.
  const order: string[] = []
  for (const t of raw) if (!order.includes(t.lang)) order.push(t.lang)
  return order.flatMap((l) => raw.filter((t) => t.lang === l))
}

// ---- subtitles -----------------------------------------------------------
// English text subtitles collapsed to one track per distinct purpose: the same
// language+content as a sidecar, an embedded ASS and an embedded SRT is a single
// "English" (styled ASS preferred). Genuinely different tracks (signs & songs,
// forced, SDH, another translation group) stay, labelled by purpose.
const isTextSub = (s: JfMediaStream) => s.IsTextSubtitleStream
  || /^(ass|ssa|subrip|srt|webvtt|vtt|mov_text|text)$/i.test(s.Codec || '')
const isEngSub = (s: JfMediaStream) => /^en/i.test(s.Language || '') || /\beng(lish)?\b/i.test(s.DisplayTitle || s.Title || '')
const isAss = (s: JfMediaStream) => /^(ass|ssa)$/i.test(s.Codec || '')
type SubCat = 'full' | 'cc' | 'signs' | 'forced'
const subCat = (s: JfMediaStream): SubCat => {
  const t = `${s.Title || ''} ${s.DisplayTitle || ''}`.toLowerCase()
  if (s.IsForced || /forced/.test(t)) return 'forced'
  if (/sdh|deaf|hard of hearing|closed caption|\bcc\b/.test(t)) return 'cc'
  if (/(sign|song)/.test(t) && !/\bfull\b/.test(t)) return 'signs'
  return 'full'
}
const subGroup = (s: JfMediaStream): string => {
  const m = `${s.Title || ''} ${s.DisplayTitle || ''}`.match(/\[([^\]]+)\]/)
  const g = m ? m[1].trim() : ''
  // Bracketed format/language tags are not release groups.
  return /^(ass|ssa|srt|subrip|vtt|subs?|text|eng(lish)?|full|default)$/i.test(g) ? '' : g
}
// What is left of the title once language, format, placement and purpose words
// are gone; separates e.g. two differently-translated groupless tracks.
const subRemnant = (s: JfMediaStream): string =>
  String(s.Title || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(eng(?:lish)?|en|ass|ssa|srt|sub(?:rip)?|subs|subtitles?|text|sidecar|external|embedded|full|dialog(?:ue)?|default|styled|plain|forced|sdh|cc|closed captions?|signs?|songs?|only|and|\d+)\b/gi, ' ')
    .replace(/[\s\-–—:|/,.()_+&]+/g, ' ').trim().toLowerCase()
const CAT_ORDER: SubCat[] = ['full', 'cc', 'signs', 'forced']
const CAT_LABEL: Record<SubCat, string> = {
  full: 'English', cc: 'English (SDH)', signs: 'English: signs & songs only', forced: 'English (forced)',
}

export function buildSubTracks(streams: JfMediaStream[]): SubTrack[] {
  const eng = streams.filter((s) => s.Type === 'Subtitle' && isTextSub(s) && isEngSub(s))
  const byStyle = (a: JfMediaStream, b: JfMediaStream) => (isAss(b) ? 1 : 0) - (isAss(a) ? 1 : 0) || a.Index - b.Index

  // Legacy selectors (pre-collapse scheme): "Full" dialogue tracks only, or all
  // English when there are none; ordinal-keyed when groupless.
  const legacy: Record<number, string> = {}
  {
    let pool = eng.filter((s) => subCat(s) === 'full')
    if (!pool.length) pool = eng
    const seen: Record<string, number> = {}
    pool.slice().sort(byStyle).forEach((s, i) => {
      const g = subGroup(s)
      const base = g ? `g:${g.toLowerCase()}` : `i:${i}`
      const n = (seen[base] = (seen[base] ?? 0) + 1)
      legacy[s.Index] = n > 1 ? `${base}#${n}` : base
    })
  }

  // Collapse by purpose key: category + group + leftover title text.
  const buckets = new Map<string, JfMediaStream[]>()
  for (const s of eng.slice().sort(byStyle)) {
    const key = `${subCat(s)}|${subGroup(s).toLowerCase()}|${subRemnant(s)}`
    const b = buckets.get(key)
    if (b) b.push(s); else buckets.set(key, [s])
  }
  const kept = [...buckets.entries()].map(([key, members]) => ({ cat: key.split('|')[0] as SubCat, s: members[0], members }))
  kept.sort((a, b) => CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat) || byStyle(a.s, b.s))

  const selSeen: Record<string, number> = {}
  const labelSeen: Record<string, number> = {}
  let fullOrd = 0
  return kept.map(({ cat, s, members }) => {
    const group = subGroup(s)
    const rem = subRemnant(s)
    let base: string
    if (cat !== 'full') base = `p:${cat}${group ? `:${group.toLowerCase()}` : rem ? `:${rem}` : ''}`
    else base = group ? `g:${group.toLowerCase()}` : `i:${fullOrd++}`
    const n = (selSeen[base] = (selSeen[base] ?? 0) + 1)
    const sel = n > 1 ? `${base}#${n}` : base
    let label = CAT_LABEL[cat]
    let detail = ''
    if (cat === 'full') { if (group) label = `English: ${group}`; else detail = rem }
    else detail = group || rem
    const dup = (labelSeen[label + detail] = (labelSeen[label + detail] ?? 0) + 1)
    if (dup > 1) detail = detail ? `${detail} ${dup}` : `Track ${dup}`
    const alts = [...new Set(members.map((m) => legacy[m.Index]).filter((a): a is string => !!a && a !== sel))]
    return { index: s.Index, group, sel, alts, label, detail }
  })
}
