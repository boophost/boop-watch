import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Check, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { fetchAuth, parseAuthJson } from '@/lib/api'
import { cn } from '@/lib/utils'

/** A search hit from /api/search/anime (AniList-primary; Jikan fallback fills
 * the extra fields with null). */
export interface AnimeSearchHit {
  mal_id: number
  title: string
  synopsis: string
  image_url: string | null
  url: string
  year: number | null
  type: string | null
  status: string | null
  episodes: number | null
  inCatalog: boolean
}

interface AddSeriesModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after each successful add so the catalog can refresh behind the modal. */
  onAdded?: () => void
  /** Seed the search box (e.g. a query already typed in the catalog bar). */
  initialQuery?: string
}

export function AddSeriesModal({ open, onOpenChange, onAdded, initialQuery = '' }: AddSeriesModalProps) {
  const [q, setQ] = useState(initialQuery)
  const [results, setResults] = useState<AnimeSearchHit[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedMal, setSelectedMal] = useState<number | null>(null)
  const [addedMals, setAddedMals] = useState<Set<number>>(new Set())
  const [addingMal, setAddingMal] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset transient state each time the modal opens; seed the query.
  useEffect(() => {
    if (open) {
      setQ(initialQuery)
      setSelectedMal(null)
      setError('')
      setAddedMals(new Set())
      // Focus after the dialog mounts.
      const t = window.setTimeout(() => inputRef.current?.focus(), 50)
      return () => window.clearTimeout(t)
    }
  }, [open, initialQuery])

  // Debounced search.
  useEffect(() => {
    if (!open) return
    const t = q.trim()
    if (!t) {
      setResults([])
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
          const hits = raw.results ?? []
          setResults(hits)
          // Auto-select the first addable hit so the detail panel isn't empty.
          setSelectedMal((cur) =>
            cur != null && hits.some((h) => h.mal_id === cur) ? cur : (hits[0]?.mal_id ?? null),
          )
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Search failed')
          setResults([])
        } finally {
          setLoading(false)
        }
      })()
    }, 380)
    return () => window.clearTimeout(id)
  }, [q, open])

  const selected = useMemo(
    () => results.find((h) => h.mal_id === selectedMal) ?? null,
    [results, selectedMal],
  )

  const isAdded = (h: AnimeSearchHit) => h.inCatalog || addedMals.has(h.mal_id)

  const addSeries = async (hit: AnimeSearchHit) => {
    if (isAdded(hit)) return
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
      if (r.status === 409) {
        // Already added elsewhere — treat as added.
        setAddedMals((s) => new Set(s).add(hit.mal_id))
        return
      }
      if (!r.ok) throw new Error(raw.error ?? 'Could not add')
      setAddedMals((s) => new Set(s).add(hit.mal_id))
      onAdded?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add')
    } finally {
      setAddingMal(null)
    }
  }

  const meta = (h: AnimeSearchHit) =>
    [h.year, h.type, h.episodes != null ? `${h.episodes} ep` : null].filter(Boolean).join(' · ')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add a series</DialogTitle>
          <DialogDescription>
            Search AniList and click a poster to review it before adding to your catalog.
          </DialogDescription>
        </DialogHeader>

        <Input
          ref={inputRef}
          type="search"
          placeholder="Search AniList…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoComplete="off"
        />

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <div className="grid min-h-[22rem] gap-4 sm:grid-cols-[1fr_18rem]">
          {/* Poster grid */}
          <div className="max-h-[26rem] overflow-y-auto pr-1">
            {loading && results.length === 0 ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" /> Searching…
              </div>
            ) : null}
            {!loading && q.trim() && results.length === 0 && !error ? (
              <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                No results
              </div>
            ) : null}
            {!q.trim() && results.length === 0 ? (
              <div className="flex h-40 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                Start typing to search for a show to add.
              </div>
            ) : null}
            {results.length > 0 ? (
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {results.map((h) => {
                  const added = isAdded(h)
                  return (
                    <li key={h.mal_id}>
                      <button
                        type="button"
                        onClick={() => setSelectedMal(h.mal_id)}
                        className={cn(
                          'group relative block w-full overflow-hidden rounded-md border text-left transition-colors',
                          selectedMal === h.mal_id
                            ? 'border-primary ring-2 ring-primary'
                            : 'border-border hover:border-muted-foreground',
                        )}
                        aria-pressed={selectedMal === h.mal_id}
                        title={h.title}
                      >
                        <div className="aspect-[2/3] w-full bg-muted">
                          {h.image_url ? (
                            <img
                              src={h.image_url}
                              alt=""
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground">
                              No art
                            </div>
                          )}
                        </div>
                        {added ? (
                          <span className="absolute right-1 top-1 flex items-center gap-0.5 rounded bg-emerald-600/90 px-1 py-0.5 text-[9px] font-medium text-white">
                            <Check className="size-2.5" /> Added
                          </span>
                        ) : null}
                        <span className="block truncate px-1.5 py-1 text-[11px] leading-tight">
                          {h.title}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </div>

          {/* Detail side panel */}
          <aside className="rounded-lg border border-border bg-muted/20 p-3">
            {selected ? (
              <div className="flex h-full flex-col gap-3">
                <div className="flex gap-3">
                  <div className="h-28 w-20 shrink-0 overflow-hidden rounded-md bg-muted">
                    {selected.image_url ? (
                      <img src={selected.image_url} alt="" className="h-full w-full object-cover" />
                    ) : null}
                  </div>
                  <div className="min-w-0">
                    <div className="font-medium leading-snug">{selected.title}</div>
                    {meta(selected) ? (
                      <div className="mt-1 text-xs text-muted-foreground">{meta(selected)}</div>
                    ) : null}
                    {selected.status ? (
                      <div className="mt-1 text-xs text-muted-foreground">{selected.status}</div>
                    ) : null}
                  </div>
                </div>
                {selected.synopsis ? (
                  <p className="line-clamp-6 text-xs text-muted-foreground">{selected.synopsis}</p>
                ) : null}
                <div className="mt-auto">
                  {isAdded(selected) ? (
                    <Button type="button" variant="outline" className="w-full gap-1" disabled>
                      <Check className="size-4" /> In your catalog
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      className="w-full gap-1"
                      onClick={() => void addSeries(selected)}
                      disabled={addingMal === selected.mal_id}
                    >
                      {addingMal === selected.mal_id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Plus className="size-4" />
                      )}
                      Add series
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
                Select a poster to see details.
              </div>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}
