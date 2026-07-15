import { useNavigate } from 'react-router-dom'
import { fetchAuth } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Plus, Trash2 } from 'lucide-react'
import { adminChaseChipLabel, type EpisodeChase } from '@/lib/chase'

export interface SeriesEntry {
  id: number
  mal_id: number
  title: string
  synopsis: string | null
  image_url: string | null
  url: string | null
  added_at: string
  episodes?: number | null
  // Multi-season placement (see server/seasonMap.ts). tvdb_id groups a show's
  // cours; tvdb_season / episode_offset place this cour in the library.
  tvdb_id?: number | null
  tvdb_season?: number | null
  episode_offset?: number | null
  mapping_source?: string | null
  nextChase?: EpisodeChase | null
}

interface SeriesListProps {
  /** The loaded catalog (owned by the parent so the search bar shares it). */
  series: SeriesEntry[]
  loading: boolean
  /** Refresh the catalog after a change (e.g. remove). */
  onChanged: () => void
  /** Open the add-series modal (the first grid cell is an add card). */
  onAddClick: () => void
}

export function SeriesList({ series, loading, onChanged, onAddClick }: SeriesListProps) {
  const navigate = useNavigate()

  const remove = async (id: number) => {
    await fetchAuth(`/api/series/${id}`, { method: 'DELETE' })
    onChanged()
  }

  if (loading && series.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading your list…</p>
  }

  const AddCard = (
    <li key="add-card">
      <button
        type="button"
        onClick={onAddClick}
        className="flex h-full min-h-[7rem] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-3 text-muted-foreground outline-none transition-colors hover:border-primary hover:bg-primary/5 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Plus className="size-7" />
        <span className="text-sm font-medium">Add a series</span>
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
          <div className="h-28 w-20 shrink-0 overflow-hidden rounded-md bg-muted">
            {s.image_url ? (
              <img
                src={s.image_url}
                alt=""
                className="h-full w-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="flex h-full items-center justify-center p-1 text-center text-[10px] text-muted-foreground">
                No poster
              </div>
            )}
          </div>
          <div className="min-w-0 flex flex-1 flex-col gap-2">
            <div>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="font-medium leading-snug">{s.title}</span>
                {s.nextChase && s.nextChase.state !== 'ready' ? (
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      s.nextChase.state === 'waiting'
                        ? 'bg-sky-500/15 text-sky-400'
                        : s.nextChase.state === 'searching'
                          ? 'bg-amber-500/15 text-amber-400'
                          : s.nextChase.state === 'downloading'
                            ? 'bg-sky-500/15 text-sky-400'
                            : 'bg-violet-500/15 text-violet-300'
                    }`}
                  >
                    {adminChaseChipLabel(s.nextChase)}
                  </span>
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
                MAL #{s.mal_id}
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
