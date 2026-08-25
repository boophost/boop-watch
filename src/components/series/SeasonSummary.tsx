import { Badge } from '@/components/ui/badge'
import {
  FILTER_LABELS, ISSUE_DISPLAY, seriesTotals, summarizeIssues,
  type EpisodeFilter, type EpisodeStatus, type SeriesHealth,
} from '@/lib/seriesStatus'

/**
 * One line of season state, plus a filter.
 *
 * Replaces the four-stage "Catalog → Download → Library → On site" strip, which
 * described the *pipeline* rather than the season and so could show all-green
 * while individual episodes were stuck. Counting episodes is what someone
 * managing a show actually wants to know.
 */
export function SeasonSummary({
  episodes,
  expected,
  filter,
  onFilter,
}: {
  episodes: EpisodeStatus[]
  expected: number | null
  filter: EpisodeFilter
  onFilter: (f: EpisodeFilter) => void
}) {
  const t = seriesTotals(episodes)
  const total = expected ?? episodes.length

  const counts: Record<EpisodeFilter, number> = {
    all: episodes.length,
    missing: episodes.filter((e) => e.stage !== 'on-portal' && e.stage !== 'unaired').length,
    'in-flight': episodes.filter((e) => ['downloading', 'imported', 'indexed'].includes(e.stage)).length,
    attention: t.attention,
  }

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm tabular-nums">
          <span>
            <span className="font-medium">{t.aired}</span>
            <span className="text-muted-foreground"> of {total} aired</span>
          </span>
          <span className="text-muted-foreground">·</span>
          <span>
            <span className="font-medium">{t.onDisk}</span>
            <span className="text-muted-foreground"> in library</span>
          </span>
          <span className="text-muted-foreground">·</span>
          <span>
            <span className="font-medium">{t.onSite}</span>
            <span className="text-muted-foreground"> on site</span>
          </span>
        </div>
        {t.attention > 0 ? (
          <button type="button" onClick={() => onFilter('attention')} className="shrink-0">
            <Badge tone="warn">
              {t.attention} need{t.attention === 1 ? 's' : ''} attention
            </Badge>
          </button>
        ) : null}
      </div>

      <div
        role="tablist"
        aria-label="Filter episodes"
        className="mt-3 flex w-fit shrink-0 rounded-md border border-border p-0.5"
      >
        {(Object.keys(FILTER_LABELS) as EpisodeFilter[]).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => onFilter(f)}
            className={`rounded px-2.5 py-1 text-sm font-medium transition-colors ${
              filter === f ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {FILTER_LABELS[f]}
            <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{counts[f]}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Quiet until something is wrong.
 *
 * The deliberate exception to keeping this a content page: when the library is
 * split across folders, or the sourcing ledger disagrees with disk, nothing
 * anywhere said so and the only symptom was an episode stuck on one word. This
 * renders nothing at all when everything is fine.
 */
export function AttentionBand({
  episodes,
  libraryDirs,
  health,
}: {
  episodes: EpisodeStatus[]
  libraryDirs: string[]
  health: SeriesHealth | null
}) {
  const issues = summarizeIssues(episodes)
  const split = libraryDirs.length > 1
  const ledger = health
    ? health.ledgerOrphans.length + health.staleCompleted.length +
      health.sourcedWantsDeadTorrent.length + health.fulfilledWantsMissingFile.length
    : 0
  if (!split && issues.length === 0 && ledger === 0) return null

  const eps = (list: number[]) =>
    list.length <= 6 ? list.join(', ') : `${list.slice(0, 6).join(', ')} +${list.length - 6}`

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <div className="text-sm font-medium text-amber-500">Needs attention</div>
      <ul className="mt-2 space-y-1 text-xs text-amber-600 dark:text-amber-500/90">
        {split ? (
          <li>
            <span className="font-medium">Library is split across {libraryDirs.length} folders</span> —{' '}
            {libraryDirs.map((d) => `"${d}"`).join(' and ')}. Jellyfin indexes these as separate
            series, so episodes in the wrong one never reach the portal.
          </li>
        ) : null}
        {issues.map((i) => (
          <li key={i.code}>
            <span className="font-medium">{ISSUE_DISPLAY[i.code].label}</span> — episode{i.episodes.length === 1 ? '' : 's'}{' '}
            {eps(i.episodes)}
          </li>
        ))}
        {health && health.fulfilledWantsMissingFile.length > 0 ? (
          <li>
            {health.fulfilledWantsMissingFile.length} want(s) marked fulfilled but their file is gone from
            disk — the reconciler will reopen these.
          </li>
        ) : null}
        {health && health.sourcedWantsDeadTorrent.length > 0 ? (
          <li>
            {health.sourcedWantsDeadTorrent.length} want(s) sourced to a download that no longer exists.
          </li>
        ) : null}
        {health && health.ledgerOrphans.length > 0 ? (
          <li>{health.ledgerOrphans.length} ledger row(s) qBittorrent no longer has.</li>
        ) : null}
        {health && health.staleCompleted.length > 0 ? (
          <li>{health.staleCompleted.length} download(s) completed over a day ago and never imported.</li>
        ) : null}
      </ul>
    </div>
  )
}
