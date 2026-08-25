import { Link } from 'react-router-dom'
import { siblingLabel, type SeriesSibling } from '@/lib/seriesStatus'

/**
 * Jump between cours of the same show.
 *
 * The catalog splits a show by cour — Mushoku Tensei is five rows across three
 * TVDB seasons — and until now moving between them meant going back to the
 * catalog and searching the title again, which is the sort of small friction
 * that stops you checking the neighbouring cour when diagnosing something.
 *
 * Shows the *shape* of each cour (season plus the episode range it occupies)
 * rather than its title: the titles are long and near-identical, so
 * "S2 · 13-24" distinguishes them where "…Season 2 Part 2" does not. The full
 * title stays as the tooltip.
 *
 * Renders nothing for a show with only one cour — a switcher with a single
 * option is noise.
 */
export function SeasonSwitch({ siblings }: { siblings: SeriesSibling[] }) {
  // Tolerates a missing/short list from an older server for the same reason.
  if (!siblings || siblings.length < 2) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">Seasons</span>
      <div className="flex flex-wrap gap-1">
        {siblings.map((s) =>
          s.isSelf ? (
            <span
              key={s.id}
              aria-current="page"
              title={s.title}
              className="rounded-md border border-ring bg-muted px-2.5 py-1 text-xs font-medium tabular-nums"
            >
              {siblingLabel(s)}
            </span>
          ) : (
            <Link
              key={s.id}
              to={`/manage/series/${s.id}`}
              title={s.title}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium tabular-nums text-muted-foreground transition-colors hover:border-ring/60 hover:text-foreground"
            >
              {siblingLabel(s)}
            </Link>
          ),
        )}
      </div>
    </div>
  )
}
