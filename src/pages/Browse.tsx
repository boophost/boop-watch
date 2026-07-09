import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '@/components/Icon'
import { PortalLayout } from '@/components/PortalLayout'
import { useAuth } from '@/lib/AuthContext'
import { recentlyWatched, type RecentWatch } from '@/lib/progress'
import {
  loadCatalog, getRecent, getFeatured, getItemSummaries, imgUrl, backdropUrl, seasonImgUrl,
  type CatalogItem, type RecentItem, type FeaturedItem, type ItemSummary,
} from '@/lib/api'

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
          <div className="feat-rank font-mono">#{i + 1} Spotlight</div>
          <div className="feat-body">
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

// One card per season (or movie). Seasons open the season page — the newest
// episode is named in the meta line rather than being the click target.
function RecentCard({ it }: { it: RecentItem }) {
  const isSeason = it.type === 'season' && it.seriesId
  const href = isSeason
    ? `/series/${it.seriesId}${it.season != null ? `?season=${it.season}` : ''}`
    : `/watch/${it.id}`
  const poster = isSeason && it.season != null
    ? seasonImgUrl(it.seriesId!, it.season)
    : imgUrl(it.seriesId || it.id)
  const when = ago(it.addedAt)
  return (
    <Link className="poster-card" to={href}>
      <div className="poster-fallback">{initials(it.name)}</div>
      <img
        src={poster} loading="lazy" alt=""
        onError={(e) => {
          // A season poster can 404 out of a cache poisoned before the server
          // learned to fall back; try the series poster before giving up.
          const img = e.currentTarget
          if (isSeason && it.seriesId && !img.dataset.fallback) {
            img.dataset.fallback = '1'
            img.src = imgUrl(it.seriesId)
            return
          }
          img.remove()
        }}
      />
      {isSeason
        ? <span className="ep-tag font-mono">{it.season != null ? `S${it.season}` : 'New'}</span>
        : <span className="type-tag"><Icon name="film" size={11} />Movie</span>}
      {!isSeason && <span className="play-hint"><Icon name="play" size={16} /></span>}
      <div className="poster-overlay">
        <div className="poster-title">{it.name}</div>
        <div className="poster-meta">
          <span className="dot dot-airing" />
          <span>{[isSeason ? it.epLabel : '', when].filter(Boolean).join(' · ') || 'New'}</span>
        </div>
      </div>
    </Link>
  )
}

// A "continue watching" card: resumes at /watch/:id with a progress underline.
function WatchedCard({ it, sum }: { it: RecentWatch; sum: ItemSummary }) {
  const pct = it.watched ? 100 : it.duration > 0 ? Math.min(100, (it.position / it.duration) * 100) : 0
  const label = sum.type === 'episode'
    ? [sum.season != null ? `S${sum.season}` : '', sum.epLabel].filter(Boolean).join('·')
    : ''
  return (
    <Link className="poster-card" to={`/watch/${it.id}`}>
      <div className="poster-fallback">{initials(sum.name)}</div>
      <img src={imgUrl(sum.seriesId || sum.id)} loading="lazy" alt="" onError={(e) => e.currentTarget.remove()} />
      {label
        ? <span className="ep-tag font-mono">{label}</span>
        : <span className="type-tag"><Icon name="film" size={11} />Movie</span>}
      <span className="play-hint"><Icon name="play" size={16} /></span>
      <div className="poster-overlay">
        <div className="poster-title">{sum.name}</div>
        <div className="poster-meta">
          <span className={`dot ${it.watched ? 'dot-info' : 'dot-airing'}`} />
          <span>{it.watched ? 'Watched' : `${Math.round(pct)}% watched`}</span>
        </div>
      </div>
      {pct > 0 && <span className="poster-progress" style={{ width: `${pct}%` }} />}
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

/** History rows paired with their scope metadata: newest first, one card per
 * title (the latest episode stands in for the show), capped at a single row. */
async function loadWatchedRail(): Promise<[RecentWatch, ItemSummary][]> {
  const rows = await recentlyWatched(30)
  if (!rows.length) return []
  const { items } = await getItemSummaries(rows.map((r) => r.id))
  const byId = new Map(items.map((s) => [s.id, s]))
  const seen = new Set<string>()
  const out: [RecentWatch, ItemSummary][] = []
  for (const r of rows) {
    const sum = byId.get(r.id)          // out-of-scope / deleted ids drop out
    if (!sum) continue
    const title = sum.seriesId || sum.id
    if (seen.has(title)) continue
    seen.add(title)
    out.push([r, sum])
    if (out.length === 12) break
  }
  return out
}

export default function Browse() {
  const { user } = useAuth()
  const [items, setItems] = useState<CatalogItem[]>([])
  const [genres, setGenres] = useState<string[]>([])
  const [recent, setRecent] = useState<RecentItem[]>([])
  const [watched, setWatched] = useState<[RecentWatch, ItemSummary][]>([])
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

  // Signed-in only: watch history lives in Supabase, RLS-scoped to the account.
  useEffect(() => {
    if (!user) { setWatched([]); return }
    let live = true
    loadWatchedRail().then((w) => { if (live) setWatched(w) }).catch(() => {})
    return () => { live = false }
  }, [user])

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

  const RecentHeading = watched.length > 0 ? 'h2' : 'h1'

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

        {watched.length > 0 && (
          <section className="home-section">
            <div className="section-head">
              <div className="h-eyebrow">Pick up where you left off</div>
              <h1 className="k-h1">Recently watched</h1>
            </div>
            <div className="grid grid-recent">
              {watched.map(([it, sum]) => <WatchedCard key={it.id} it={it} sum={sum} />)}
            </div>
          </section>
        )}

        {recent.length > 0 && (
          <section className="home-section">
            <div className="section-head">
              <div className="h-eyebrow">New releases</div>
              {/* The watched rail owns the page's h1 when it's on screen. */}
              <RecentHeading className="k-h1">Recently updated</RecentHeading>
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
