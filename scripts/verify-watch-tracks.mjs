#!/usr/bin/env node
// Smoke tests for server/watchTracks.ts (audio labels + subtitle collapse).
// Run: node scripts/verify-watch-tracks.mjs
// Optional live check (read-only): WATCH_URL=https://… WATCH_IDS=id1,id2 prints the menus
// /api/watch/:id returns, for eyeballing against real titles.
import { buildAudioTracks, buildSubTracks } from '../server/watchTracks.ts'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
const eq = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}`)

const aud = (Index, Language, Title, Codec, Channels, IsDefault = false) =>
  ({ Index, Type: 'Audio', Language, Title, Codec, Channels, IsDefault })
const sub = (Index, Codec, Title, extra = {}) =>
  ({ Index, Type: 'Subtitle', Language: 'eng', Codec, Title, IsTextSubtitleStream: true, ...extra })

// --- Kai S01E01: 5 audio (3 English scores + 2 Japanese), 3 English subs ---
{
  const streams = [
    { Index: 0, Type: 'Video', Codec: 'h264' },
    aud(1, 'eng', 'English - Faulconer score', 'ac3', 2),
    aud(2, 'eng', 'English: Kenji Yamamoto score', 'ac3', 6, true),
    aud(3, 'eng', 'Shunsuke Kikuchi score', 'ac3', 2),
    aud(4, 'jpn', 'Japanese - Kenji Yamamoto', 'aac', 2),
    aud(5, 'jpn', 'Japanese (Shunsuke Kikuchi)', 'aac', 2),
    sub(6, 'ass', 'English'),                 // external sidecar S01E01.eng.ass
    sub(7, 'ass', 'English'),                 // embedded ASS
    sub(8, 'subrip', 'English [SRT]'),        // embedded SRT plain copy
  ]
  const a = buildAudioTracks(streams)
  eq(a.map((t) => t.label), [
    'English: Faulconer score', 'English: Kenji Yamamoto score', 'English: Shunsuke Kikuchi score',
    'Japanese: Kenji Yamamoto', 'Japanese: Shunsuke Kikuchi',
  ], 'kai audio labels')
  assert(new Set(a.map((t) => t.label)).size === 5, 'kai audio labels must be distinct')
  eq(a[1].detail, '5.1', 'kai audio detail is channels')
  assert(a.every((t) => !/ac3|aac/i.test(t.label + t.detail)), 'codec must not appear when a title exists')

  const s = buildSubTracks(streams)
  eq(s.length, 1, 'kai subs collapse to one')
  eq(s[0].label, 'English', 'kai sub label')
  eq(s[0].index, 6, 'kai keeps the first ASS')
  eq(s[0].sel, 'i:0', 'kai sel stays the legacy ordinal selector')
}

// --- a show with a signs-only track + SDH + forced + a second group ---
{
  const streams = [
    aud(1, 'jpn', '', 'aac', 2, true),
    sub(2, 'ass', '[Judas] Full'),
    sub(3, 'subrip', '[Judas] Full'),
    sub(4, 'ass', '[Judas] Signs & Songs'),
    sub(5, 'subrip', 'English SDH'),
    sub(6, 'ass', '', { IsForced: true }),
    sub(7, 'ass', '[Erai-raws]'),
  ]
  const s = buildSubTracks(streams)
  eq(s.map((t) => t.label), [
    'English: Judas', 'English: Erai-raws', 'English (SDH)', 'English: signs & songs only', 'English (forced)',
  ], 'multi-purpose labels')
  eq(s[0].index, 2, 'ASS preferred over SRT')
  assert(new Set(s.map((t) => t.sel)).size === s.length, 'selectors unique')
  assert(s.find((t) => t.label.includes('signs')).detail === 'Judas', 'group kept as detail on signs track')

  // Legacy remembered selector for the collapsed SRT must still resolve to the kept ASS.
  const legacy = s.find((t) => t.index === 2)
  assert(legacy.alts.length === 0 || legacy.alts.every((x) => typeof x === 'string'), 'alts well-formed')
}

// --- remembered selectors survive the collapse ---
{
  // Old scheme: pool of full tracks sorted ASS-first -> idx6 i:0, idx7 i:1, idx8 i:2.
  const streams = [sub(6, 'ass', 'English'), sub(7, 'ass', 'English'), sub(8, 'subrip', 'English')]
  const s = buildSubTracks(streams)
  eq(s.length, 1, 'collapsed')
  for (const old of ['i:0', 'i:1', 'i:2']) {
    assert(s[0].sel === old || s[0].alts.includes(old), `legacy selector ${old} must still resolve`)
  }
  // Grouped legacy duplicates.
  const g = buildSubTracks([sub(1, 'ass', '[Grp]'), sub(2, 'subrip', '[Grp]')])
  eq(g.length, 1, 'group collapsed')
  assert(g[0].sel === 'g:grp' && g[0].alts.includes('g:grp#2'), 'g:grp#2 resolves')
}

// --- single-audio show: no title -> codec/channels fallback; no subs ---
{
  const a = buildAudioTracks([aud(1, 'jpn', undefined, 'aac', 2, true)])
  eq(a.length, 1, 'single audio')
  eq([a[0].label, a[0].detail], ['Japanese', 'AAC · Stereo'], 'fallback label/detail')
  // A title that only restates the codec is no title.
  const b = buildAudioTracks([aud(1, 'eng', 'English AAC 2.0', 'aac', 2, true)])
  eq([b[0].label, b[0].detail], ['English', 'AAC · Stereo'], 'tech-only title falls back')
  eq(buildSubTracks([]), [], 'no subs')
  // Groups by language even when streams interleave.
  const c = buildAudioTracks([aud(1, 'jpn', 'A', 'aac', 2), aud(2, 'eng', 'B', 'aac', 2), aud(3, 'jpn', 'C', 'aac', 2)])
  eq(c.map((t) => t.index), [1, 3, 2], 'grouped by language')
}

// --- edge-case audio titles ---
{
  const a = buildAudioTracks([
    aud(1, 'eng', 'English', 'ac3', 2, true),          // title is only the language
    aud(2, 'eng', 'ENG: Director commentary', 'ac3', 2),
    aud(3, 'eng', 'English - Alt dub', 'ac3', 6),
    aud(4, 'jpn', undefined, 'aac', 2),                // no title
  ])
  eq(a.map((t) => [t.label, t.detail]), [
    ['English', 'AC3 · Stereo'], ['English: Director commentary', 'Stereo'], ['English: Alt dub', '5.1'], ['Japanese', 'AAC · Stereo'],
  ], 'audio edge cases')
}

// --- an SRT with extra title text still collapses into the ASS (same purpose, no group) ---
{
  const s = buildSubTracks([sub(6, 'ass', 'English'), sub(7, 'subrip', 'English (SRT plain text copy)')])
  eq(s.length, 1, 'srt with extra title collapses')
  eq(s[0].index, 6, 'ass kept')
}

// --- groupless extracted sidecar folds into the single embedded group track ---
{
  const ext = { IsExternal: true }
  const s = buildSubTracks([
    sub(0, 'ass', 'English', ext),                         // S01E01.eng.ass extracted by import
    sub(7, 'ass', '[MTBB] English'),
    sub(8, 'ass', '[MTBB] English', { IsForced: true }),
  ])
  eq(s.map((t) => t.label), ['English: MTBB', 'English (forced)'], 'mushoku collapse')
  eq(s[0].index, 7, 'embedded track is kept')
  assert(s[0].alts.includes('i:0'), 'sidecar selector resolves to the embedded track')
  // Two groups: ambiguous, so the sidecar stays.
  const t = buildSubTracks([sub(0, 'ass', 'English', ext), sub(1, 'ass', '[A]'), sub(2, 'ass', '[B]')])
  eq(t.length, 3, 'ambiguous sidecar not collapsed')
  // An embedded groupless track is never folded.
  eq(buildSubTracks([sub(0, 'ass', 'English'), sub(1, 'ass', '[A]')]).length, 2, 'embedded groupless kept')
}

// --- optional live (read-only) dump ---
if (process.env.WATCH_URL && process.env.WATCH_IDS) {
  for (const id of process.env.WATCH_IDS.split(',')) {
    const r = await fetch(`${process.env.WATCH_URL.replace(/\/$/, '')}/api/watch/${id}`)
    const d = await r.json()
    console.log(id, d.title, '\n  audio:', d.audio?.tracks?.map((t) => `${t.label} · ${t.detail}`), '\n  subs:', d.subs?.map((t) => `${t.label}${t.detail ? ` (${t.detail})` : ''}`))
  }
}

console.log('verify-watch-tracks: ok')
