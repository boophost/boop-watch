import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '@/components/Icon'
import { PortalLayout, ScheduleCrumb } from '@/components/PortalLayout'
import { loadCatalog, imgUrl, type CatalogItem } from '@/lib/api'

const initials = (n: string) =>
  String(n || '?').split(/[^a-z0-9]/i).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase()

type SortKey = 'name' | 'year' | 'type'

function PosterCard({ it }: { it: CatalogItem }) {
  const isSeries = it.type === 'Series'
  return (
    <Link className="poster-card" to={isSeries ? `/series/${it.id}` : `/movie/${it.id}`}>
      <div className="poster-fallback">{initials(it.name)}</div>
      <img src={imgUrl(it.id)} loading="lazy" alt="" onError={(e) => e.currentTarget.remove()} />
      <span className="type-tag"><Icon name={isSeries ? 'tv' : 'film'} size={11} />{isSeries ? 'Series' : 'Movie'}</span>
      <div className="poster-overlay">
        <div className="poster-title">{it.name}</div>
        <div className="poster-meta">
          {isSeries
            ? <><span className="dot dot-info" /><span>Series</span></>
            : <><span className="dot dot-airing" /><span className="font-mono">{it.year || 'Film'}</span></>}
        </div>
      </div>
    </Link>
  )
}

export default function Browse() {
  const [items, setItems] = useState<CatalogItem[]>([])
  const [genres, setGenres] = useState<string[]>([])
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('name')
  const [tag, setTag] = useState('')
  const [tagsOpen, setTagsOpen] = useState(false)

  useEffect(() => {
    loadCatalog()
      .then((c) => { setItems(c.items); setGenres(c.genres) })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoaded(true))
  }, [])

  const visible = useMemo(() => {
    const v = q.trim().toLowerCase()
    const matches = (c: CatalogItem) => {
      if (v && !c.name.toLowerCase().includes(v)) return false
      if (!tag) return true
      if (tag.startsWith('type:')) return (c.type || '').toLowerCase() === tag.slice(5)
      if (tag.startsWith('genre:')) return (c.genres || []).some((g) => g.toLowerCase() === tag.slice(6))
      return true
    }
    return items.filter(matches).sort((a, b) => {
      if (sort === 'year') return (b.year || 0) - (a.year || 0) || a.name.localeCompare(b.name)
      if (sort === 'type') return (a.type || '').localeCompare(b.type || '') || a.name.localeCompare(b.name)
      return a.name.localeCompare(b.name)
    })
  }, [items, q, sort, tag])

  const chips: [string, string][] = [
    ['', 'All'], ['type:movie', 'Movies'], ['type:series', 'Series'],
    ...genres.map((g) => [`genre:${g.toLowerCase()}`, g] as [string, string]),
  ]

  return (
    <PortalLayout crumb={ScheduleCrumb}>
      <main>
        <div className="section-head">
          <div className="h-eyebrow">Public library</div>
          <h1 className="k-h1">Watch</h1>
        </div>

        {error && <p className="empty">{error}</p>}
        {!error && loaded && items.length === 0 && (
          <p className="empty">Nothing here yet. Add titles to the “Public” collection in Jellyfin.</p>
        )}

        {items.length > 0 && (
          <>
            <div className="cat-bar">
              <div className="cat-filter">
                <Icon name="search" size={15} />
                <input
                  type="search" placeholder="Filter titles…" autoComplete="off" aria-label="Filter titles"
                  value={q} onChange={(e) => setQ(e.target.value)}
                />
              </div>
              <button
                className="cat-tags-toggle" type="button"
                aria-expanded={tagsOpen} aria-controls="cat-chips"
                data-filtered={tag !== ''}
                onClick={() => setTagsOpen((o) => !o)}
              >
                <Icon name="tag" size={14} /><span>Tags</span><Icon name="chevron" size={14} />
              </button>
              <label className="cat-sort">Sort
                <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                  <option value="name">Name</option>
                  <option value="year">Year</option>
                  <option value="type">Type</option>
                </select>
              </label>
            </div>

            <div className="cat-chips" id="cat-chips" hidden={!tagsOpen}>
              {chips.map(([t, label]) => (
                <button key={t || 'all'} className="chip" type="button" data-active={t === tag} onClick={() => setTag(t)}>
                  {label}
                </button>
              ))}
            </div>

            <div className="grid">
              {visible.map((it) => <PosterCard key={it.id} it={it} />)}
            </div>
            {visible.length === 0 && <p className="empty">No titles match your filter.</p>}
          </>
        )}
      </main>
    </PortalLayout>
  )
}
