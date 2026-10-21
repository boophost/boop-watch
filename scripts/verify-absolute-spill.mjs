#!/usr/bin/env node
// Smoke tests for transform.absolute-spill / spillAbsoluteEpisode (no vitest in this repo).
const { spillAbsoluteEpisode, resolveCourLength, buildSpillCatalog } = await import('../server/absoluteSpill.ts')
const { NODE_REGISTRY } = await import('../server/flowNodes.ts')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
const cour = (mal_id, tvdb_id, tvdb_season, episodes, episode_offset = 0) => ({ mal_id, tvdb_id, tvdb_season, episode_offset, episodes })
const kai = cour(6033, 88031, 1, 98)
const finalCh = cour(22777, 88031, 2, 61)
const catalog = [kai, finalCh, cour(1, 5, 1, 12), cour(2, null, null, null), cour(3, 9, 1, null), cour(4, 9, 2, 12)]

// In range: never touched.
assert(spillAbsoluteEpisode(98, kai, catalog).kind === 'in-range', '098 stays S01E98')
assert(spillAbsoluteEpisode(1, kai, catalog).kind === 'in-range', '001 stays')

// Spill.
let r = spillAbsoluteEpisode(99, kai, catalog)
assert(r.kind === 'spilled' && r.cour.mal_id === 22777 && r.cour.tvdb_season === 2 && r.episode === 1, '099 -> 22777 E1')
r = spillAbsoluteEpisode(159, kai, catalog)
assert(r.kind === 'spilled' && r.cour.mal_id === 22777 && r.episode === 61, '159 -> 22777 E61')

// Past the last sibling: unchanged with a reason.
r = spillAbsoluteEpisode(160, kai, catalog)
assert(r.kind === 'unchanged' && /past the last sibling/.test(r.reason), '160 left unchanged with a note')

// No siblings.
r = spillAbsoluteEpisode(20, catalog[2], catalog)
assert(r.kind === 'unchanged' && /no sibling/.test(r.reason), 'show with no siblings unchanged')
r = spillAbsoluteEpisode(20, catalog[3], catalog)
assert(r.kind === 'unchanged', 'unmapped cour unchanged')

// Unknown count.
r = spillAbsoluteEpisode(20, catalog[4], catalog)
assert(r.kind === 'unchanged' && /unknown/.test(r.reason), 'unknown count unchanged')

// Chain through three cours: 12 + 12 + 12.
const c1 = cour(10, 7, 1, 12), c2 = cour(11, 7, 2, 12), c3 = cour(12, 7, 3, 12)
const chain = [c3, c1, c2]
r = spillAbsoluteEpisode(30, c1, chain)
assert(r.kind === 'spilled' && r.cour.mal_id === 12 && r.episode === 6, 'chains across cours')
r = spillAbsoluteEpisode(25, c1, chain)
assert(r.kind === 'spilled' && r.cour.mal_id === 12 && r.episode === 1, 'chain boundary')
r = spillAbsoluteEpisode(37, c1, chain)
assert(r.kind === 'unchanged', 'past a three-cour chain unchanged')

// Boundary source: override > TVDB > MAL. Kai: MAL says 97, TVDB S1 and the pack have 98.
let L = resolveCourLength({ episodes: 97 }, 98)
assert(L.episodes === 98 && L.source === 'tvdb', 'TVDB beats MAL')
L = resolveCourLength({ episodes: 97, season_length: 99 }, 98)
assert(L.episodes === 99 && L.source === 'override', 'override beats TVDB')
L = resolveCourLength({ episodes: 97 }, undefined)
assert(L.episodes === 97 && L.source === 'mal', 'MAL-only fallback')
L = resolveCourLength({ episodes: 97 }, 50)
assert(L.source === 'mal', 'a TVDB count shorter than MAL is an incomplete library, ignored')
const kaiMal = { mal_id: 6033, tvdb_id: 88031, tvdb_season: 1, episode_offset: 0, episodes: 97 }
const kaiFixed = { ...kaiMal, episodes: resolveCourLength(kaiMal, 98).episodes }
const kaiCat = [kaiFixed, finalCh]
assert(spillAbsoluteEpisode(98, kaiFixed, kaiCat).kind === 'in-range', 'Kai 098 stays S01E98')
r = spillAbsoluteEpisode(99, kaiFixed, kaiCat)
assert(r.kind === 'spilled' && r.cour.mal_id === 22777 && r.episode === 1, 'Kai 099 -> S02E01')
r = spillAbsoluteEpisode(159, kaiFixed, kaiCat)
assert(r.kind === 'spilled' && r.cour.mal_id === 22777 && r.episode === 61, 'Kai 159 -> S02E61')
// With MAL's 97 the old behaviour would have been wrong:
assert(spillAbsoluteEpisode(98, kaiMal, [kaiMal, finalCh]).kind === 'spilled', 'sanity: MAL 97 mis-spills 098')

// Lazy lookups: TVDB lengths are only fetched for shows with real overflow.
{
  const rows = [
    { mal_id: 6033, tvdb_id: 88031, tvdb_season: 1, episode_offset: 0, episodes: 97, season_length: null },
    { mal_id: 22777, tvdb_id: 88031, tvdb_season: 2, episode_offset: 0, episodes: 61, season_length: null },
    { mal_id: 1, tvdb_id: 5, tvdb_season: 1, episode_offset: 0, episodes: 12, season_length: null },
  ]
  let calls = 0
  const fetchLengths = async () => (calls++, new Map([[1, 98], [2, 61]]))
  await buildSpillCatalog(rows, [{ mal_id: 6033, episode: 97 }, { mal_id: 6033, episode: 1 }, { mal_id: 1, episode: 50 }], fetchLengths)
  assert(calls === 0, 'in-range batch (and a show with no sibling) makes no lookup')
  let cat = await buildSpillCatalog(rows, [{ mal_id: 6033, episode: 98 }, { mal_id: 6033, episode: 159 }], fetchLengths)
  assert(calls === 1, 'overflow triggers exactly one lookup per show')
  const k = cat.find((c) => c.mal_id === 6033)
  assert(k.episodes === 98 && k.episodes_source === 'tvdb', 'lookup result used as boundary')
  calls = 0
  const withOverride = rows.map((x) => (x.mal_id === 6033 ? { ...x, season_length: 98 } : x))
  cat = await buildSpillCatalog(withOverride, [{ mal_id: 6033, episode: 159 }], fetchLengths)
  assert(calls === 0 && cat.find((c) => c.mal_id === 6033).episodes_source === 'override', 'override needs no lookup')
}

// The node, against the real (empty-or-not) catalog: an item with no catalog row passes through.
const node = NODE_REGISTRY.get('transform.absolute-spill')
assert(node, 'node registered')
const notes = []
const item = { mal_id: 999999999, torrent_episode: 150 }
const out = await node.run({ in: [item] }, {}, { notes, dryRun: true })
assert(out.out.length === 1 && out.out[0].torrent_episode === 150, 'unknown mal passes through')

console.log('verify-absolute-spill: ok')
