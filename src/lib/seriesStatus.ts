// Client mirror of GET /api/series/:id/status (server/seriesStatus.ts), plus the
// display vocabulary for it.
//
// The stage list is the point. The page used to render "importing" for three
// materially different situations — bytes on disk, indexed by Jellyfin, playable
// on the portal — and a series that had genuinely finished importing into a
// folder Jellyfin read as a *different* show looked identical to one still
// downloading. Each stage below is separately observable, so that gap is now a
// thing the page can name.

export type EpisodeStage =
  | 'unaired'
  | 'wanted'
  | 'searching'
  | 'downloading'
  | 'imported'
  | 'indexed'
  | 'on-portal'

export type EpisodeIssueCode =
  | 'stalled'
  | 'ghost-file'
  | 'unindexed'
  | 'off-portal'
  | 'dead-torrent'
  | 'audio-outlier'

export interface EpisodeIssue {
  code: EpisodeIssueCode
  detail: string
}

export interface EpisodeAudio {
  lang: string
  label: string
  codec: string
  channels: string
  def: boolean
}

export interface EpisodeMedia {
  id: string
  episode: number | null
  season: number | null
  resolution: string
  videoCodec: string
  audio: EpisodeAudio[]
  subLangs: string[]
  sizeBytes: number | null
  container: string
  runtimeMin: number | null
}

export interface EpisodeStatus {
  episode: number
  libraryEpisode: number
  title: string | null
  airedAt: string | null
  want: {
    id: number
    status: 'open' | 'sourced' | 'fulfilled' | 'abandoned'
    reason: string | null
    attempts: number
    lastAttemptAt: string | null
    nextAttemptAt: string | null
    note: string | null
  } | null
  torrent: {
    hash: string
    name: string | null
    status: string
    provider: string | null
    note: string | null
    liveState: string | null
    progress: number | null
  } | null
  file: {
    path: string
    sizeBytes: number | null
    method: string | null
    importedAt: string
    existsOnDisk: boolean
  } | null
  jellyfin: { itemId: string } | null
  portal: { itemId: string } | null
  media: EpisodeMedia | null
  stage: EpisodeStage
  issues: EpisodeIssue[]
}

export interface SeriesHealth {
  ledgerOrphans: { hash: string; name: string | null; status: string }[]
  staleCompleted: { hash: string; name: string | null; completed_at: string | null }[]
  sourcedWantsDeadTorrent: { want_id: number; episode: number | null; torrent_status: string | null }[]
  fulfilledWantsMissingFile: { want_id: number; episode: number | null; library_path: string | null }[]
}

export interface SeriesStatus {
  seriesId: number
  section: string
  malId: number | null
  seasonNumber: number | null
  episodeOffset: number
  episodes: EpisodeStatus[]
  libraryDirs: string[]
  health: SeriesHealth | null
  unmatchedTorrents: {
    hash: string
    name: string
    state: string
    progress: number
    size: number
    episode: number | null
  }[]
  qbitConfigured: boolean
  qbitError: string | null
}

type Tone = 'done' | 'active' | 'accent' | 'warn' | 'error' | 'muted'

/** Label + tone for a stage chip. Wording is deliberately plain — someone
 * scanning nineteen rows should not have to translate jargon. */
export const STAGE_DISPLAY: Record<EpisodeStage, { label: string; tone: Tone; hint: string }> = {
  unaired: { label: 'Not aired', tone: 'muted', hint: 'This episode has not aired yet.' },
  wanted: { label: 'Wanted', tone: 'muted', hint: 'Queued to be searched for.' },
  searching: { label: 'Searching', tone: 'warn', hint: 'Looking for a release; nothing found yet.' },
  downloading: { label: 'Downloading', tone: 'active', hint: 'A release is downloading.' },
  // The three that used to be one word.
  imported: { label: 'On disk', tone: 'active', hint: 'The file is in the library but Jellyfin has not indexed it yet.' },
  indexed: { label: 'In Jellyfin', tone: 'active', hint: 'Jellyfin has the file, but it is not on the public portal.' },
  'on-portal': { label: 'On site', tone: 'done', hint: 'Watchable on the portal.' },
}

export const ISSUE_DISPLAY: Record<EpisodeIssueCode, { label: string; tone: Tone }> = {
  stalled: { label: 'Stalled', tone: 'warn' },
  'ghost-file': { label: 'File missing', tone: 'error' },
  unindexed: { label: 'Not in Jellyfin', tone: 'warn' },
  'off-portal': { label: 'Not on site', tone: 'warn' },
  'dead-torrent': { label: 'Dead download', tone: 'error' },
  'audio-outlier': { label: 'Audio differs', tone: 'warn' },
}

export const STAGE_ORDER: EpisodeStage[] = [
  'unaired', 'wanted', 'searching', 'downloading', 'imported', 'indexed', 'on-portal',
]

export type EpisodeFilter = 'all' | 'missing' | 'in-flight' | 'attention'

export const FILTER_LABELS: Record<EpisodeFilter, string> = {
  all: 'All',
  missing: 'Missing',
  'in-flight': 'In flight',
  attention: 'Needs attention',
}

export function matchesFilter(e: EpisodeStatus, f: EpisodeFilter): boolean {
  if (f === 'all') return true
  if (f === 'attention') return e.issues.length > 0
  if (f === 'in-flight') return e.stage === 'downloading' || e.stage === 'imported' || e.stage === 'indexed'
  // "Missing" means: aired, and not watchable. An unaired episode isn't missing,
  // it just hasn't happened yet — lumping those together made the count useless.
  return e.stage !== 'on-portal' && e.stage !== 'unaired'
}

export interface SeriesTotals {
  aired: number
  onDisk: number
  onSite: number
  attention: number
}

export function seriesTotals(episodes: EpisodeStatus[]): SeriesTotals {
  let aired = 0
  let onDisk = 0
  let onSite = 0
  let attention = 0
  for (const e of episodes) {
    if (e.stage !== 'unaired') aired++
    if (e.file?.existsOnDisk || e.jellyfin || e.portal) onDisk++
    if (e.portal) onSite++
    if (e.issues.length > 0) attention++
  }
  return { aired, onDisk, onSite, attention }
}

/** Every issue on the series, deduped by code, for the attention band. */
export function summarizeIssues(episodes: EpisodeStatus[]): { code: EpisodeIssueCode; episodes: number[] }[] {
  const by = new Map<EpisodeIssueCode, number[]>()
  for (const e of episodes) {
    for (const i of e.issues) {
      const list = by.get(i.code) ?? []
      list.push(e.episode)
      by.set(i.code, list)
    }
  }
  return [...by.entries()].map(([code, eps]) => ({ code, episodes: eps.sort((a, b) => a - b) }))
}
