import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { fetchAuth } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Plus, Trash2, TriangleAlert } from 'lucide-react'
import { adminChaseChipLabel, type EpisodeChase } from '@/lib/chase'
import {
  courShapeLabel,
  courShapeOf,
  groupSeries,
  groupSubtitle,
  type SeriesEntry,
  type SeriesGroup,
} from '@/lib/seriesGroups'
import type { PortalSection } from '@/lib/sections'

export type { SeriesEntry } from '@/lib/seriesGroups'

interface SeriesListProps {
  /** Which section is being shown — decides the empty-state wording. */
  section?: PortalSection
  /** The loaded catalog (owned by the parent so the search bar shares it). */
  series: SeriesEntry[]
  loading: boolean
  /** One row per show rather than per cour. See src/lib/seriesGroups.ts. */
  grouped?: boolean
  /** Refresh the catalog after a change (e.g. remove). */
  onChanged: () => void
  /** Open the add-series modal (the first grid cell is an add card). */
  onAddClick: () => void
}

function ChaseChip({ chase }: { chase: EpisodeChase }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
        chase.state === 'waiting'
          ? 'bg-sky-500/15 text-sky-400'
          : chase.state === 'searching'
            ? 'bg-amber-500/15 text-amber-400'
            : chase.state === 'downloading'
              ? 'bg-sky-500/15 text-sky-400'
              : 'bg-violet-500/15 text-violet-300'
      }`}
    >
      {adminChaseChipLabel(chase)}
    </span>
  )
}

function Poster({ url, className }: { url: string | null; className: string }) {
  return (
    <div className={`shrink-0 overflow-hidden rounded-md bg-muted ${className}`}>
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex h-full items-center justify-center p-1 text-center text-[10px] text-muted-foreground">
          No poster
        </div>
      )}
    </div>
  )
}

/**
 * One show: its cours as season chips, each linking to that cour's page.
 *
 * Laid out as a full-width row rather than a grid cell because the chips are
 * the point and they need the width — a five-cour show does not fit a third of
 * the page. A single-cour group renders the same way with one chip, so the
 * list stays one shape instead of two.
 */
function GroupRow({ group, onRemove }: { group: SeriesGroup; onRemove: (id: number) => void }) {
  const single = group.rows.length === 1 ? group.rows[0] : null
  const subtitle = groupSubtitle(group)
  const missing = group.missingSeasons

  return (
    <li className="flex gap-3 rounded-lg border border-border bg-card p-3 shadow-sm transition-colors hover:bg-muted/40">
      <Link
        to={`/manage/series/${group.rows[0].id}`}
        aria-label={group.title}
        className="shrink-0 outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Poster url={group.poster} className="h-[68px] w-12" />
      </Link>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <Link
            to={`/manage/series/${group.rows[0].id}`}
            className="font-medium leading-snug outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {group.title}
          </Link>
          {subtitle ? (
            <span className="text-xs text-muted-foreground">{subtitle}</span>
          ) : null}
          {/* A row with no tvdb_id cannot be grouped, and its imports fall
              back to Season 1 — the second half is why this is worth a badge
              rather than just an absence. */}
          {group.unmapped ? (
            <span
              title="No season mapping — imports fall back to Season 1 with no offset"
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400"
            >
              <TriangleAlert className="size-2.5" />
              unmapped
            </span>
          ) : null}
          {group.overlapping.length > 0 ? (
            <span
              title={`Two cours both claim ${group.overlapDetail ?? 'the same episodes'}. Sometimes a wrong episode offset, sometimes the provider counting a recap the library does not — worth checking before either cour sources again.`}
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400"
            >
              <TriangleAlert className="size-2.5" />
              episode overlap
            </span>
          ) : null}
          {group.nextChase ? <ChaseChip chase={group.nextChase} /> : null}
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {group.rows[0].tvdb_id != null
              ? `tvdb ${group.rows[0].tvdb_id}`
              : group.rows[0].mal_id != null
                ? `mal ${group.rows[0].mal_id}`
                : group.rows[0].source_id != null
                  ? `tmdb ${group.rows[0].source_id}`
                  : ''}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {group.rows.map((r) => (
            <Link
              key={r.id}
              to={`/manage/series/${r.id}`}
              title={r.title}
              className={`rounded-md border px-2.5 py-1 font-mono text-[11px] tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                group.overlapping.includes(r.id)
                  ? 'border-amber-500/40 text-amber-300 hover:border-amber-500/70'
                  : 'border-border text-muted-foreground hover:border-ring/60 hover:text-foreground'
              }`}
            >
              {/* Without a season there is no shape to name, and "— · 1-12"
                  reads as a broken label rather than as a missing mapping. */}
              {r.tvdb_season != null
                ? courShapeLabel(courShapeOf(r))
                : r.episodes != null
                  ? `${r.episodes} episodes`
                  : 'no mapping'}
            </Link>
          ))}
          {missing.length > 0 ? (
            <span className="rounded-md border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground">
              {missing.map((s) => `S${s}`).join(', ')} not in the catalog
            </span>
          ) : null}
          {/* Remove stays per-cour, so it is only offered where "the row" is
              unambiguous. Removing one cour of a five-cour show is a job for
              the flat view (or that cour's own page), not for a chip. */}
          {single ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto h-7 shrink-0 gap-1 px-2"
              onClick={() => void onRemove(single.id)}
              aria-label={`Remove ${single.title}`}
            >
              <Trash2 className="size-3" />
              Remove
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  )
}

export function SeriesList({
  section = 'anime',
  series,
  loading,
  grouped = false,
  onChanged,
  onAddClick,
}: SeriesListProps) {
  const navigate = useNavigate()
  const groups = useMemo(() => (grouped ? groupSeries(series) : []), [grouped, series])

  const remove = async (id: number) => {
    await fetchAuth(`/api/series/${id}`, { method: 'DELETE' })
    onChanged()
  }

  if (loading && series.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading your list…</p>
  }

  const addLabel =
    section === 'movies' ? 'Add a movie' : section === 'tv' ? 'Add a show' : 'Add a series'

  if (grouped) {
    return (
      <ul className="flex flex-col gap-2.5">
        {groups.map((g) => (
          <GroupRow key={g.key} group={g} onRemove={remove} />
        ))}
        <li>
          <button
            type="button"
            onClick={onAddClick}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border p-3 text-muted-foreground outline-none transition-colors hover:border-primary hover:bg-primary/5 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-4" />
            <span className="text-sm font-medium">{addLabel}</span>
          </button>
        </li>
      </ul>
    )
  }

  const AddCard = (
    <li key="add-card">
      <button
        type="button"
        onClick={onAddClick}
        className="flex h-full min-h-[7rem] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-3 text-muted-foreground outline-none transition-colors hover:border-primary hover:bg-primary/5 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus className="size-7" />
        <span className="text-sm font-medium">{addLabel}</span>
      </button>
    </li>
  )

  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {AddCard}
      {series.map((s) => (
        <li
          key={s.id}
          role="button"
          tabIndex={0}
          className="flex cursor-pointer gap-3 rounded-lg border border-border bg-card p-3 shadow-sm outline-none ring-offset-background transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => navigate(`/manage/series/${s.id}`)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              navigate(`/manage/series/${s.id}`)
            }
          }}
        >
          <Poster url={s.image_url} className="h-28 w-20" />
          <div className="min-w-0 flex flex-1 flex-col gap-2">
            <div>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="font-medium leading-snug">{s.title}</span>
                {s.nextChase && s.nextChase.state !== 'ready' ? (
                  <ChaseChip chase={s.nextChase} />
                ) : null}
              </div>
              <span className="mt-0.5 block text-[10px] text-muted-foreground">
                Open for episodes and details
              </span>
              {s.synopsis ? (
                <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
                  {s.synopsis}
                </p>
              ) : null}
            </div>
            <div className="mt-auto flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">
                {s.mal_id != null ? `MAL #${s.mal_id}` : s.source_id != null ? `TMDB #${s.source_id}` : ''}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="relative z-10 h-8 shrink-0 gap-1 px-2"
                onClick={(e) => {
                  e.stopPropagation()
                  void remove(s.id)
                }}
                aria-label={`Remove ${s.title}`}
              >
                <Trash2 className="size-3.5" />
                Remove
              </Button>
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
