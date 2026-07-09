#!/usr/bin/env node
// Smoke tests for server/episodeChase.ts (no vitest in this repo).
import {
  estimateNextAir,
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
  assert(pub?.state === 'downloading', 'public state')
}

{
  const done = resolveNextChase({
    episodes: [{ episode: 1, aired: '2026-07-01T15:00:00Z' }],
    siteEpisodes: { '1': 'jf-1' },
    libraryEpisodes: new Set([1]),
    torrents: [],
    malEpisodes: 1,
    now,
  })
  assert(done === null, 'no chase when MAL total met')
}

{
  // Chainsmoker Cat: ep1 only, Fridays 00:30 JST → ep2 estimated Jul 10 00:30 JST.
  const broadcast = { day: 'Fridays', time: '00:30', timezone: 'Asia/Tokyo' }
  const estimated = estimateNextAir({
    nextEpisode: 2,
    episodes: [{ episode: 1, title: 'Ep 1', aired: '2026-07-03T00:00:00+00:00' }],
    broadcast,
    now,
  })
  assert(estimated != null, 'estimate returned')
  // 2026-07-10 00:30 JST = 2026-07-09 15:30 UTC
  assert(estimated === '2026-07-09T15:30:00.000Z', `estimated=${estimated}`)

  const synth = resolveNextChase({
    episodes: [{ episode: 1, title: 'Ep 1', aired: '2026-07-03T00:00:00+00:00' }],
    siteEpisodes: { '1': 'jf-1' },
    libraryEpisodes: new Set([1]),
    torrents: [],
    malEpisodes: null,
    broadcast,
    now,
  })
  assert(synth?.episode === 2, `synth ep=${synth?.episode}`)
  assert(synth?.state === 'waiting', `synth state=${synth?.state}`)
  assert(synth?.airsAt === '2026-07-09T15:30:00.000Z', `synth airsAt=${synth?.airsAt}`)
}

console.log('verify-episode-chase: ok')
