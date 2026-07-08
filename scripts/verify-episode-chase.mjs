#!/usr/bin/env node
// Smoke tests for server/episodeChase.ts (no vitest in this repo).
import {
  resolveExpected,
  resolveNextChase,
  toPublicChase,
} from '../server/episodeChase.ts'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const now = Date.parse('2026-07-08T18:00:00Z')
const eps = [
  { episode: 1, title: 'Ep 1', aired: '2026-07-01T15:00:00Z' },
  { episode: 2, title: 'Ep 2', aired: '2026-07-15T15:00:00Z' },
]

{
  const { airedCount, expected } = resolveExpected(12, eps, now)
  assert(airedCount === 1, `airedCount=${airedCount}`)
  assert(expected === 1, `expected=${expected} (catch-up, not MAL 12)`)
}

{
  const chase = resolveNextChase({
    episodes: eps,
    siteEpisodes: { '1': 'jf-1' },
    libraryEpisodes: new Set([1]),
    torrents: [],
    now,
  })
  assert(chase?.episode === 2, `next ep=${chase?.episode}`)
  assert(chase?.state === 'waiting', `state=${chase?.state}`)
}

{
  const past = [
    { episode: 1, aired: '2026-07-01T15:00:00Z' },
    { episode: 2, aired: '2026-07-07T15:00:00Z' },
  ]
  const searching = resolveNextChase({
    episodes: past,
    siteEpisodes: { '1': 'jf-1' },
    libraryEpisodes: new Set([1]),
    torrents: [],
    now,
  })
  assert(searching?.state === 'searching', `searching=${searching?.state}`)

  const downloading = resolveNextChase({
    episodes: past,
    siteEpisodes: { '1': 'jf-1' },
    libraryEpisodes: new Set([1]),
    torrents: [{ episode: 2, progress: 0.42 }],
    now,
  })
  assert(downloading?.state === 'downloading', `dl=${downloading?.state}`)
  assert(Math.abs((downloading?.progress ?? 0) - 0.42) < 1e-9, 'progress')

  const importing = resolveNextChase({
    episodes: past,
    siteEpisodes: { '1': 'jf-1' },
    libraryEpisodes: new Set([1, 2]),
    torrents: [{ episode: 2, progress: 1 }],
    now,
  })
  assert(importing?.state === 'importing', `imp=${importing?.state}`)

  const pub = toPublicChase(downloading)
  assert(pub && !('progress' in pub && pub.progress != null) || pub?.progress === undefined, 'public omits progress')
  // toPublicChase returns object without progress field set
  assert(pub?.state === 'downloading', 'public state')
}

{
  const done = resolveNextChase({
    episodes: [{ episode: 1, aired: '2026-07-01T15:00:00Z' }],
    siteEpisodes: { '1': 'jf-1' },
    libraryEpisodes: new Set([1]),
    torrents: [],
    now,
  })
  assert(done === null, 'no chase when caught up with only aired ep')
}

console.log('verify-episode-chase: ok')
