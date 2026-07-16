import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { fetchAuth, parseAuthJson } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { AnimeSearchHit } from '@/components/AddSeriesModal'

/** A minimal shape of the catalog entries this bar filters over. */
export interface CatalogLite {
  id: number
  mal_id: number
  title: string
  image_url: string | null
}

interface AnimeSearchProps {
  className?: string
  /** The already-loaded catalog — filtered client-side for the top tier. */
  catalog: CatalogLite[]
  /** Called after an inline AniList add so the catalog refreshes. */
  onChanged?: () => void
  /** Open the full add-series modal, seeded with the current query. */
  onOpenAddModal: (query: string) => void
}

/** Catalog-first search: filters the loaded catalog (navigate on click) and
 * offers a few AniList "add new" suggestions below a separator (add on click),
 * plus a button into the full add-series modal. */
export function AnimeSearch({ className, catalog, onChanged, onOpenAddModal }: AnimeSearchProps) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [suggestions, setSuggestions] = useState<AnimeSearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [addingMal, setAddingMal] = useState<number | null>(null)
  const [error, setError] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const h = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', h)
    return () => document.removeEventListener('pointerdown', h)
  }, [open])

  // Client-side catalog matches (instant; the catalog is small).
  const catalogMatches = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return []
    return catalog.filter((s) => s.title.toLowerCase().includes(t)).slice(0, 6)
  }, [q, catalog])

  // Debounced AniList suggestions for the "add new" tier.
  useEffect(() => {
    const t = q.trim()
    if (!t) {
      setSuggestions([])
      setLoading(false)
      setError('')
      return
    }
    const id = window.setTimeout(() => {
      void (async () => {
        setLoading(true)
        setError('')
        try {
          const r = await fetchAuth(`/api/search/anime?q=${encodeURIComponent(t)}`)
          const raw = await parseAuthJson<{ results?: AnimeSearchHit[]; error?: string }>(r)
          if (!r.ok) throw new Error(raw.error ?? 'Search failed')
          setSuggestions(raw.results ?? [])
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Search failed')
          setSuggestions([])
        } finally {
          setLoading(false)
        }
      })()
    }, 380)
    return () => window.clearTimeout(id)
  }, [q])

  // Suggestions worth showing as "add new": not already in the catalog (those
  // already appear in the top tier) and not a redundant repeat.
  const addable = useMemo(
    () => suggestions.filter((h) => !h.inCatalog).slice(0, 4),
    [suggestions],
  )

  const goTo = (id: number) => {
    setOpen(false)
    setQ('')
    navigate(`/manage/series/${id}`)
  }

  const addImmediately = async (hit: AnimeSearchHit) => {
    setAddingMal(hit.mal_id)
    setError('')
    try {
      const r = await fetchAuth('/api/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mal_id: hit.mal_id,
          title: hit.title,
          synopsis: hit.synopsis,
          image_url: hit.image_url,
          url: hit.url,
        }),
      })
      const raw = await parseAuthJson<{ error?: string }>(r)
      if (!r.ok && r.status !== 409) throw new Error(raw.error ?? 'Could not add')
      // Drop it from suggestions so the row reflects the add.
      setSuggestions((s) => s.map((x) => (x.mal_id === hit.mal_id ? { ...x, inCatalog: true } : x)))
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add')
    } finally {
      setAddingMal(null)
    }
  }

  const showPanel = open && q.trim().length > 0

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <Input
        type="search"
        placeholder="Search your catalog…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        className="w-full"
        autoComplete="off"
        aria-expanded={open}
        aria-controls="anime-search-results"
      />
      {showPanel ? (
        <div
          id="anime-search-results"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-96 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
          role="listbox"
        >
          {/* Tier 1 — catalog matches */}
          {catalogMatches.length > 0 ? (
            <div>
              {catalogMatches.map((s) => (
                <button
                  key={`cat-${s.id}`}
                  type="button"
                  role="option"
                  className="flex w-full items-center gap-3 border-b border-border p-2.5 text-left last:border-b-0 hover:bg-muted/80"
                  onClick={() => goTo(s.id)}
                >
                  <div className="h-12 w-9 shrink-0 overflow-hidden rounded bg-muted">
                    {s.image_url ? (
                      <img src={s.image_url} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : null}
                  </div>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">In catalog</span>
                </button>
              ))}
            </div>
          ) : null}

          {catalogMatches.length === 0 && !loading ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No catalog match for “{q.trim()}”.
            </div>
          ) : null}

          {/* Tier 2 — AniList "add new" suggestions (visually distinct) */}
          {addable.length > 0 ? (
            <div className="border-t border-border bg-primary/5">
              <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-primary/80">
                Add from AniList
              </div>
              {addable.map((h) => (
                <button
                  key={`al-${h.mal_id}`}
                  type="button"
                  role="option"
                  disabled={h.inCatalog || addingMal === h.mal_id}
                  className="flex w-full items-center gap-3 border-b border-border/60 p-2.5 text-left last:border-b-0 hover:bg-primary/10 disabled:opacity-60"
                  onClick={() => void addImmediately(h)}
                >
                  <div className="h-12 w-9 shrink-0 overflow-hidden rounded bg-muted">
                    {h.image_url ? (
                      <img src={h.image_url} alt="" className="h-full w-full object-cover" loading="lazy" />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{h.title}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {[h.year, h.type, h.episodes != null ? `${h.episodes} ep` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                  <span className="flex shrink-0 items-center gap-1 rounded bg-primary/15 px-2 py-1 text-[11px] font-medium text-primary">
                    {h.inCatalog ? (
                      'Added'
                    ) : addingMal === h.mal_id ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <>
                        <Plus className="size-3" /> Add
                      </>
                    )}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {loading && addable.length === 0 ? (
            <div className="flex items-center gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Searching AniList…
            </div>
          ) : null}

          {error ? <div className="px-3 py-2 text-xs text-destructive">{error}</div> : null}

          {/* Tier 3 — open the full modal */}
          <button
            type="button"
            className="flex w-full items-center gap-2 border-t border-border bg-muted/40 px-3 py-2.5 text-left text-sm font-medium hover:bg-muted"
            onClick={() => {
              setOpen(false)
              onOpenAddModal(q.trim())
            }}
          >
            <Plus className="size-4" /> Add new series…
          </button>
        </div>
      ) : null}
    </div>
  )
}
