import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { fetchAuth } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Plus, Trash2, TriangleAlert } from 'lucide-react'
import { adminChaseChipLabel, type EpisodeChase } from '@/lib/chase'
import {
  courShapeLabel,
  courShapeOf,
  filterGroups,
  groupSeries,
  groupSubtitle,
  sortGroups,
  type CatalogSort,
  type SeriesEntry,
  type SeriesGroup,
} from '@/lib/seriesGroups'
import type { PortalSection } from '@/lib/sections'

export type { SeriesEntry } from '@/lib/seriesGroups'

export type CatalogView = 'list' | 'grid'

interface SeriesListProps {
  /** Which section is being shown — decides the empty-state wording. */
  section?: PortalSection
  /** The loaded catalog (owned by the parent so the search bar shares it). */
  series: SeriesEntry[]
  loading: boolean
  /** Both views show one entry per show (see src/lib/seriesGroups.ts); this
   *  only picks the layout. */
  view?: CatalogView
  sort?: CatalogSort
  /** Narrows the list in place; see filterGroups for what it matches. */
  query?: string
  /** Refresh the catalog after a change (e.g. remove). */
  onChanged: () => void
  /** Open the add-title modal, seeded with a query when the filter found
   *  nothing (the title may simply not be in the catalog yet). */
  onAddClick: (query?: string) => void
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

/**
 * What a row's own chip says.
 *
 * "no mapping" is anime vocabulary — a TMDB row has no season mapping to be
 * missing, so a TV or movie row with nothing to report shows no chip at all
 * rather than borrowing a warning from the other section's model. Without a
 * season there is likewise no shape to name, and "— · 1-12" reads as a broken
 * label rather than as a missing mapping.
 */
function courChipLabel(r: SeriesEntry): string | null {
  if (r.tvdb_season != null) return courShapeLabel(courShapeOf(r))
  if (r.section === 'movies') return r.year != null ? String(r.year) : null
  if (r.episodes != null) return `${r.episodes} episodes`
  return (r.section ?? 'anime') === 'anime' ? 'no mapping' : null
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

/** Status badges for a show: unmapped, overlapping cours, and its chase. */
function GroupBadges({ group }: { group: SeriesGroup }) {
  return (
    <>
      {/* A row with no tvdb_id cannot be grouped, and its imports fall back to
          Season 1 — the second half is why this is worth a badge rather than
          just an absence. */}
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
    </>
  )
}

function groupKeyLabel(group: SeriesGroup): string {
  const r = group.rows[0]
  if (r.tvdb_id != null) return `tvdb ${r.tvdb_id}`
  if (r.mal_id != null) return `mal ${r.mal_id}`
  if (r.source_id != null) return `tmdb ${r.source_id}`
  return ''
}

/** The show's seasons as chips, plus a note for any hole in the run. */
function GroupChips({ group }: { group: SeriesGroup }) {
  // Present only for a TV row (see SeriesEntry.librarySeasons).
  const librarySeasons = group.rows.length === 1 ? group.rows[0].librarySeasons : null
  return (
    <>
      {/* Two sources for the same idea, "which seasons does this show have".
          Anime splits a show across catalog rows, so each chip is a cour and
          links to its own page. A TV row *is* the show, so its chips come from
          the library and all describe this one row — rendered as plain text,
          because five chips linking to the same place would just be five ways
          to press the title. */}
      {librarySeasons
        ? librarySeasons.map((c) => (
            <span
              key={c.season}
              className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] tabular-nums text-muted-foreground"
            >
              S{c.season} · {c.episodes} ep{c.episodes === 1 ? '' : 's'}
            </span>
          ))
        : group.rows.map((r) => {
            const label = courChipLabel(r)
            if (!label) return null
            return (
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
                {label}
              </Link>
            )
          })}
      {group.missingSeasons.length > 0 ? (
        <span className="rounded-md border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground">
          {group.missingSeasons.map((s) => `S${s}`).join(', ')} not in the catalog
        </span>
      ) : null}
    </>
  )
}

/**
 * Remove, offered only where "the row" is unambiguous — a single-cour show.
 * One cour of a multi-cour show is removed from that cour's own page, since a
 * chip is too small a target for something destructive.
 */
function RemoveButton({ group, onRemove }: { group: SeriesGroup; onRemove: (id: number) => void }) {
  const single = group.rows.length === 1 ? group.rows[0] : null
  if (!single) return null
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 shrink-0 gap-1 px-2"
      onClick={() => void onRemove(single.id)}
      aria-label={`Remove ${single.title}`}
    >
      <Trash2 className="size-3" />
      Remove
    </Button>
  )
}

/**
 * List layout: one full-width row per show. Chips get the width a grid cell
 * does not have, so a five-cour show reads on one line.
 */
function GroupRow({ group, onRemove }: { group: SeriesGroup; onRemove: (id: number) => void }) {
  const subtitle = groupSubtitle(group)
  const href = `/manage/series/${group.rows[0].id}`
  return (
    <li className="flex gap-3 rounded-lg border border-border bg-card p-3 shadow-sm transition-colors hover:bg-muted/40">
      <Link
        to={href}
        aria-label={group.title}
        className="shrink-0 outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Poster url={group.poster} className="h-[68px] w-12" />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <Link
            to={href}
            className="font-medium leading-snug outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {group.title}
          </Link>
          {subtitle ? <span className="text-xs text-muted-foreground">{subtitle}</span> : null}
          <GroupBadges group={group} />
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">{groupKeyLabel(group)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <GroupChips group={group} />
          <span className="ml-auto">
            <RemoveButton group={group} onRemove={onRemove} />
          </span>
        </div>
      </div>
    </li>
  )
}

/**
 * Grid layout: one card per show — the old grid's shape (poster, synopsis,
 * footer) carrying the grouped data, so switching view changes the layout and
 * nothing else.
 */
function GroupCard({ group, onRemove }: { group: SeriesGroup; onRemove: (id: number) => void }) {
  const subtitle = groupSubtitle(group)
  const href = `/manage/series/${group.rows[0].id}`
  const synopsis = group.rows.find((r) => r.synopsis)?.synopsis ?? null
  return (
    <li className="flex gap-3 rounded-lg border border-border bg-card p-3 shadow-sm transition-colors hover:bg-muted/40">
      <Link
        to={href}
        aria-label={group.title}
        className="shrink-0 self-start outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Poster url={group.poster} className="h-28 w-20" />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div>
          <Link
            to={href}
            className="font-medium leading-snug outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {group.title}
          </Link>
          {subtitle ? <span className="mt-0.5 block text-xs text-muted-foreground">{subtitle}</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
          <GroupBadges group={group} />
        </div>
        {synopsis ? <p className="line-clamp-2 text-xs text-muted-foreground">{synopsis}</p> : null}
        <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
          <GroupChips group={group} />
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="font-mono text-[10px] text-muted-foreground">{groupKeyLabel(group)}</span>
          <RemoveButton group={group} onRemove={onRemove} />
        </div>
      </div>
    </li>
  )
}

export function SeriesList({
  section = 'anime',
  series,
  loading,
  view = 'list',
  sort = 'added',
  query = '',
  onChanged,
  onAddClick,
}: SeriesListProps) {
  const groups = useMemo(
    () => filterGroups(sortGroups(groupSeries(series), sort), query),
    [series, sort, query],
  )

  const remove = async (id: number) => {
    await fetchAuth(`/api/series/${id}`, { method: 'DELETE' })
    onChanged()
  }

  if (loading && series.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading your list…</p>
  }

  const addLabel =
    section === 'movies' ? 'Add a movie' : section === 'tv' ? 'Add a show' : 'Add a series'
  const trimmed = query.trim()

  // A filter that matches nothing usually means "not in the catalog yet", so
  // the empty state offers the add flow with the query already typed.
  if (trimmed && groups.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">Nothing in this catalog matches “{trimmed}”.</p>
        <Button type="button" size="sm" variant="outline" className="gap-1" onClick={() => onAddClick(trimmed)}>
          <Plus className="size-4" />
          Search to add “{trimmed}”
        </Button>
      </div>
    )
  }

  if (view === 'grid') {
    return (
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <li>
          <button
            type="button"
            onClick={() => onAddClick()}
            className="flex h-full min-h-[7rem] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-3 text-muted-foreground outline-none transition-colors hover:border-primary hover:bg-primary/5 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="size-7" />
            <span className="text-sm font-medium">{addLabel}</span>
          </button>
        </li>
        {groups.map((g) => (
          <GroupCard key={g.key} group={g} onRemove={remove} />
        ))}
      </ul>
    )
  }

  return (
    <ul className="flex flex-col gap-2.5">
      {/* First, as in the grid: the add action should not move further away
          the more titles there are. */}
      <li>
        <button
          type="button"
          onClick={() => onAddClick()}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border p-3 text-muted-foreground outline-none transition-colors hover:border-primary hover:bg-primary/5 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-4" />
          <span className="text-sm font-medium">{addLabel}</span>
        </button>
      </li>
      {groups.map((g) => (
        <GroupRow key={g.key} group={g} onRemove={remove} />
      ))}
    </ul>
  )
}
