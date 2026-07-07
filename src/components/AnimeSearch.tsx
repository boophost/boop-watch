import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { fetchAuth, parseAuthJson } from '@/lib/api'

export interface AnimeSearchHit {
  mal_id: number
  title: string
  synopsis: string
  image_url: string | null
  url: string
}

interface AnimeSearchProps {
  className?: string
  onAdded?: () => void
}

export function AnimeSearch({ className, onAdded }: AnimeSearchProps) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<AnimeSearchHit[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const h = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', h)
    return () => document.removeEventListener('pointerdown', h)
  }, [open])

  useEffect(() => {
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
          const r = await fetchAuth(
            `/api/search/anime?q=${encodeURIComponent(t)}`,
          )
          const raw = await parseAuthJson<{ results?: AnimeSearchHit[]; error?: string }>(r)
          if (!r.ok) {
            throw new Error(raw.error ?? 'Search failed')
          }
          setResults(raw.results ?? [])
        } catch (e) {
          setError(e instanceof Error ? e.message : 'Search failed')
          setResults([])
        } finally {
          setLoading(false)
        }
      })()
    }, 380)
    return () => window.clearTimeout(id)
  }, [q])

  const addSeries = async (hit: AnimeSearchHit) => {
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
        setError(raw.error ?? 'Already in your list')
        return
      }
      if (!r.ok) {
        throw new Error(raw.error ?? 'Could not add')
      }
      setOpen(false)
      setQ('')
      setResults([])
      setError('')
      onAdded?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add')
    }
  }

  const showPanel =
    open && (q.trim().length > 0 || loading || results.length > 0 || error.length > 0)

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <Input
        type="search"
        placeholder="Search anime (MyAnimeList via Jikan)…"
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
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
          role="listbox"
        >
          {loading ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              Searching…
            </div>
          ) : null}
          {error ? (
            <div className="px-3 py-2 text-sm text-destructive">{error}</div>
          ) : null}
          {!loading
            ? results.map((hit) => (
                <button
                  key={hit.mal_id}
                  type="button"
                  role="option"
                  className="flex w-full gap-3 border-b border-border p-3 text-left last:border-b-0 hover:bg-muted/80"
                  onClick={() => void addSeries(hit)}
                >
                  <div className="h-20 w-14 shrink-0 overflow-hidden rounded-md bg-muted">
                    {hit.image_url ? (
                      <img
                        src={hit.image_url}
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
                  <div className="min-w-0 flex-1">
                    <div className="font-medium leading-snug">{hit.title}</div>
                    {hit.synopsis ? (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {hit.synopsis}
                      </p>
                    ) : null}
                  </div>
                </button>
              ))
            : null}
          {!loading && q.trim() && results.length === 0 && !error ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              No results
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
