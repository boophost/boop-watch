#!/usr/bin/env node
// Smoke tests for planTvGaps / torrentCoverage (enrich.sourcing-gaps). No vitest in this repo.
const { planTvGaps, torrentCoverage } = await import('../server/sourcingGaps.ts')
const { NODE_REGISTRY, releaseNamesTitle } = await import('../server/flowNodes.ts')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const season = (s, n, aired = '2025-01-01') =>
  Array.from({ length: n }, (_, i) => ({ season: s, episode: i + 1, aired }))
const plan = (episodes, extra = {}) =>
  planTvGaps({ episodes, onSite: new Set(), torrents: [], today: '2026-10-29', seasonPacks: true, ...extra })

// Coverage parsing.
assert(eq(torrentCoverage('Show S01E02 1080p WEB h264'), { seasons: { from: 1, to: 1 }, episode: 2 }), 'SxxEyy')
assert(eq(torrentCoverage('Show 3x07 720p'), { seasons: { from: 3, to: 3 }, episode: 7 }), 'NxNN')
assert(eq(torrentCoverage('The Office S03 1080p BluRay x264'), { seasons: { from: 3, to: 3 }, episode: null }), 'season pack')
assert(eq(torrentCoverage('The Office Season 4 Complete'), { seasons: { from: 4, to: 4 }, episode: null }), 'Season N')
assert(eq(torrentCoverage('The Office S01-S09 Complete Series'), { seasons: { from: 1, to: 9 }, episode: null }), 'range')
assert(torrentCoverage('Marcial Maciel The Wolf of God 1080p').seasons === 'all', 'unmarked = all')
assert(torrentCoverage('Show 1920x1080 WEB').seasons === 'all', 'a resolution is not NxNN')

// A fully-aired, fully-missing season collapses to one pack; specials are ignored.
let r = plan([...season(0, 3), ...season(1, 4)])
assert(eq(r.missing, [{ kind: 'batch', season: 1, episodes: 4 }]), 'whole season -> pack, no specials')

// Packs off -> per episode.
r = plan(season(1, 3), { seasonPacks: false })
assert(r.missing.length === 3 && r.missing.every((m) => m.kind === 'episode'), 'packs off -> episodes')

// Part of a season held (on site, or a single-episode torrent) -> only the rest, per episode.
r = plan(season(1, 4), { onSite: new Set(['1:1']), torrents: ['Show S01E02 1080p'] })
assert(eq(r.missing, [{ kind: 'episode', season: 1, episode: 3 }, { kind: 'episode', season: 1, episode: 4 }]), 'partial season')
assert(r.held === 2, 'held counts site + torrent')

// A season pack torrent covers its season only.
r = plan([...season(1, 2), ...season(2, 2)], { torrents: ['Show S01 1080p'] })
assert(eq(r.missing, [{ kind: 'batch', season: 2, episodes: 2 }]), 'S01 pack covers S1 only')

// An unmarked torrent (miniseries) covers everything.
r = plan(season(1, 4), { torrents: ['Show 1080p WEB'] })
assert(r.missing.length === 0 && r.held === 4, 'unmarked torrent covers all')

// Airing season: never a pack; unaired episodes are not wanted.
r = plan([...season(1, 2), { season: 1, episode: 3, aired: '2026-11-05' }, { season: 1, episode: 4, aired: null }])
assert(eq(r.missing.map((m) => m.kind), ['episode', 'episode']) && r.unaired === 2, 'airing season -> aired episodes only')

// An episode airing today counts.
r = plan([{ season: 1, episode: 1, aired: '2026-10-29' }], { seasonPacks: false })
assert(r.missing.length === 1, 'aired today counts')

// onlySeason restricts the plan (the pack-missed fallback).
r = plan([...season(1, 2), ...season(2, 2)], { seasonPacks: false, onlySeason: 2 })
assert(r.missing.length === 2 && r.missing.every((m) => m.season === 2), 'onlySeason')

// Dotted episode markers are episodes, not packs.
assert(eq(torrentCoverage('One.Tree.Hill.S01.E01.SWESUB.DVDRip'), { seasons: { from: 1, to: 1 }, episode: 1 }), 'S01.E01')

// strictTitle: the word after the title must be a marker.
const named = (n, t) => releaseNamesTitle(n, [t])
assert(named('Criminal.Minds.S01.COMPLETE.720p.WEBRip.x264', 'criminal minds'), 'show itself')
assert(!named('Criminal.Minds.Suspect.Behavior.S01.COMPLETE.720p.WEBRip.x264-Ga', 'criminal minds'), 'spin-off rejected')
assert(!named('Criminal.Minds.Beyond.Borders.S02.COMPLETE.720p', 'criminal minds'), 'spin-off rejected 2')
assert(named('The.Office.US.S03.1080p.BluRay', 'the office'), 'country tag allowed')
assert(named('Iron Man (2008) 1080p BrRip x264 - 1.65GB - YIFY', 'iron man'), 'movie with year')
assert(!named('Iron Man 2 (2010) 1080p', 'iron man'), 'sequel rejected')
assert(named('Blade Runner 2049 (2017) 1080p', 'blade runner 2049'), 'title containing a year')
assert(named('[Group] One Tree Hill Season 3 Complete', 'one tree hill'), 'leading group tag')

// Registered.
assert(NODE_REGISTRY.has('enrich.sourcing-gaps'), 'node registered')

console.log('verify-sourcing-gaps: all checks passed')
