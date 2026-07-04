import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '@/components/Icon'
import { PortalLayout } from '@/components/PortalLayout'
import { loadCatalog, getRecent, getFeatured, imgUrl, backdropUrl, type CatalogItem, type RecentItem, type FeaturedItem } from '@/lib/api'

const initials = (n: string) =>
  String(n || '?').split(/[^a-z0-9]/i).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase()

// "3h ago" / "2d ago" — coarse on purpose; the rail is about recency, not timestamps.
function ago(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${Math.max(mins, 1)}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`
}

type SortKey = 'name' | 'year' | 'type'

function FeaturedBanner({ items }: { items: FeaturedItem[] }) {
  const [idx, setIdx] = useState(0)
  // Auto-advance; depending on idx restarts the timer after a manual dot click.
  useEffect(() => {
    if (items.length < 2) return
    const t = setInterval(() => setIdx((i) => (i + 1) % items.length), 6500)
    return () => clearInterval(t)
  }, [items.length, idx])

  return (
    <section className="feat" aria-roledescription="carousel" aria-label="Featured titles">
      {items.map((it, i) => (
        <div className="feat-slide" key={it.id} data-active={i === idx} aria-hidden={i !== idx}>
          <div className="feat-bg">
            <img
              src={backdropUrl(it.id)} alt="" loading={i === 0 ? 'eager' : 'lazy'}
              onError={(e) => {
                const img = e.currentTarget
                if (img.dataset.fallback) { img.remove(); return }
                img.dataset.fallback = '1'
                img.src = imgUrl(it.id)
              }}
            />
          </div>
          <div className="feat-scrim" />
          <div className="feat-body">
            <div className="feat-rank font-mono">#{i + 1} Spotlight</div>
            <h2 className="feat-title">{it.name}</h2>
            <div className="feat-meta">
              <span className="badge badge-accent">{it.type === 'series' ? 'Series' : 'Movie'}</span>
              {it.year != null && <span className="badge badge-mono">{it.year}</span>}
              {it.epCount != null && it.epCount > 0 && <span className="badge">{it.epCount} episodes</span>}
              {it.genres.map((g) => <span className="badge" key={g}>{g}</span>)}
            </div>
            {it.overview && <p className="feat-desc">{it.overview}</p>}
            <div className="feat-actions">
              <Link className="btn btn-primary" to={`/watch/${it.watchId}`}>
                <Icon name="play" size={15} />Watch now
              </Link>
              <Link className="btn btn-secondary" to={`/${it.type === 'series' ? 'series' : 'movie'}/${it.id}`}>
                Details
              </Link>
            </div>
          </div>
        </div>
      ))}
      {items.length > 1 && (
        <div className="feat-dots">
          {items.map((it, i) => (
            <button
              key={it.id} className="feat-dot" type="button" data-active={i === idx}
              aria-label={`Show ${it.name}`} onClick={() => setIdx(i)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function RecentCard({ it }: { it: RecentItem }) {
  const posterId = it.seriesId || it.id
  return (
    <Link className="poster-card" to={`/watch/${it.id}`}>
      <div className="poster-fallback">{initials(it.name)}</div>
      <img src={imgUrl(posterId)} loading="lazy" alt="" onError={(e) => e.currentTarget.remove()} />
      {it.epLabel
        ? <span className="ep-tag font-mono">{it.epLabel}</span>
        : <span className="type-tag"><Icon name="film" size={11} />Movie</span>}
      <span className="play-hint"><Icon name="play" size={16} /></span>
      <div className="poster-overlay">
        <div className="poster-title">{it.name}</div>
        <div className="poster-meta">
          <span className="dot dot-airing" />
          <span>{ago(it.addedAt) || (it.type === 'episode' ? 'New episode' : 'New')}</span>
        </div>
      </div>
    </Link>
  )
}

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
  const [recent, setRecent] = useState<RecentItem[]>([])
  const [featured, setFeatured] = useState<FeaturedItem[]>([])
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
    // The banner and rail are bonuses — if they fail, the library still renders.
    getRecent().then((r) => setRecent(r.items)).catch(() => {})
    getFeatured().then((r) => setFeatured(r.items)).catch(() => {})
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
    <PortalLayout>
      <main>
        {featured.length > 0 && <FeaturedBanner items={featured} />}

        {error && <p className="empty">{error}</p>}
        {!error && loaded && items.length === 0 && (
          <p className="empty">Nothing here yet. Add titles to the “Public” collection in Jellyfin.</p>
        )}

        {recent.length > 0 && (
          <section className="home-section">
            <div className="section-head">
              <div className="h-eyebrow">Just added</div>
              <h1 className="k-h1">Recently updated</h1>
            </div>
            <div className="grid grid-recent">
              {recent.map((it) => <RecentCard key={it.id} it={it} />)}
            </div>
          </section>
        )}

        {items.length > 0 && (
          <section className="home-section">
            <div className="section-head">
              <div className="h-eyebrow">Everything available</div>
              <h2 className="k-h1">Full library</h2>
            </div>
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
          </section>
        )}
      </main>
    </PortalLayout>
  )
}
