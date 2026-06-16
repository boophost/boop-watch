import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Trash2 } from 'lucide-react'

export interface SeriesEntry {
  id: number
  mal_id: number
  title: string
  synopsis: string | null
  image_url: string | null
  url: string | null
  added_at: string
}

interface SeriesListProps {
  refreshKey: number
}

export function SeriesList({ refreshKey }: SeriesListProps) {
  const navigate = useNavigate()
  const [series, setSeries] = useState<SeriesEntry[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/series', { credentials: 'include' })
      if (!r.ok) throw new Error('load failed')
      const d = (await r.json()) as { series: SeriesEntry[] }
      setSeries(d.series)
    } catch {
      setSeries([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const remove = async (id: number) => {
    await fetch(`/api/series/${id}`, { method: 'DELETE', credentials: 'include' })
    void load()
  }

  if (loading && series.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Loading your list…</p>
    )
  }

  if (series.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No series yet. Search above and click a result to add it.
      </p>
    )
  }

  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
              <span className="font-medium leading-snug">{s.title}</span>
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
