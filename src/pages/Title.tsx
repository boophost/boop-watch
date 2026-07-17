import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Icon } from '@/components/Icon'
import { EpisodeStatus } from '@/components/EpisodeStatus'
import { WatchedToggle } from '@/components/WatchedToggle'
import { PortalLayout, BackCrumb } from '@/components/PortalLayout'
import { getTitle, imgUrl, backdropUrl, seasonImgUrl, saveAnime, unsaveAnime, getSavedAnimes, type TitleDetail } from '@/lib/api'
import type { ChaseState } from '@/lib/chase'
import { useAuth } from '@/lib/AuthContext'
import { loadProgressMap, type Progress } from '@/lib/progress'
import { track } from '@/lib/analytics'

const initials = (n: string) =>
  String(n || '?').split(/[^a-z0-9]/i).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase()

// Hero banner that never blanks: the current image stays put while the next
// one preloads off-screen, then fades in on a stacked layer. (Swapping a CSS
// background-image directly drops the old paint before the new fetch lands.)
function CrossfadeBackdrop({ src }: { src: string }) {
  const [shown, setShown] = useState(src)
  const [incoming, setIncoming] = useState<string | null>(null)

  useEffect(() => {
    if (src === shown) { setIncoming(null); return }
    let cancelled = false
    const img = new Image()
    // On error still promote the new src — the scrim + bg color cover it.
    img.onload = img.onerror = () => { if (!cancelled) setIncoming(src) }
    img.src = src
    return () => { cancelled = true }
  }, [src, shown])

  // The sharp layer is a real <img>, not a background: a banner is usually much
  // wider than the hero is tall, so at full width it paints only the top of the
  // box and used to stop dead against the blurred fill. An <img> is sized by the
  // art itself, so the fade in `.hero .backdrop img` lands on the image's own
  // bottom edge at any width or aspect ratio.
  return (
    <>
      <div className="backdrop" style={{ '--backdrop-img': `url('${shown}')` } as React.CSSProperties}>
        <img src={shown} alt="" draggable={false} />
      </div>
      {incoming != null && (
        <div
          key={incoming}
          className="backdrop backdrop-fade"
          style={{ '--backdrop-img': `url('${incoming}')` } as React.CSSProperties}
          onAnimationEnd={() => { setShown(incoming); setIncoming(null) }}
        >
          <img src={incoming} alt="" draggable={false} />
        </div>
      )}
    </>
  )
}

// Poster image that hides itself on error but recovers when the src changes
// (a removed element would leave the fallback stuck across season swaps).
// A season poster can 404 from a browser cache poisoned before the server
// learned to fall back, so try `fallback` once before giving up.
function PosterImg({ src, fallback }: { src: string; fallback?: string }) {
  const [cur, setCur] = useState(src)
  const [ok, setOk] = useState(true)
  useEffect(() => { setCur(src); setOk(true) }, [src])
  const onError = () => {
    if (fallback && cur !== fallback) setCur(fallback)
    else setOk(false)
  }
  return ok ? <img src={cur} alt="" onError={onError} /> : null
}

function DetailShell({
  id, name, seasonLine, badges, sub, overview, manageId, poster, backdrop, children,
}: {
  id: string; name: string
  /** Second line of the title block: the season this page is showing. */
  seasonLine?: string | null
  badges?: ReactNode; sub?: string; overview?: string
  manageId?: number | null; poster?: string; backdrop?: string; children: ReactNode
}) {
  const { user } = useAuth()
  const isAdmin = user?.isAdmin ?? false
  const [isSaved, setIsSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (user) {
      getSavedAnimes().then(r => {
        setIsSaved(r.saved.some(s => s.item_id === id))
      }).catch(() => {})
    }
  }, [user, id])

  const toggleSave = async () => {
    if (!user) return
    setSaving(true)
    try {
      if (isSaved) {
        await unsaveAnime(id)
        setIsSaved(false)
      } else {
        await saveAnime(id)
        setIsSaved(true)
        track('title_saved', { item_id: id, auth_state: 'authenticated' })
      }
    } catch (e) {
      console.error('Failed to toggle save', e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <main>
      <div className="hero">
        <CrossfadeBackdrop src={backdrop ?? backdropUrl(id)} />
        <div className="scrim" />
      </div>
      <div className="series-head">
        <div className="series-poster">
          <div className="poster-fallback" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontFamily: 'var(--font-mono)', color: 'oklch(1 0 0 / 55%)' }}>
            {initials(name)}
          </div>
          <PosterImg src={poster ?? imgUrl(id)} fallback={imgUrl(id)} />
        </div>
        <div className="series-info">
          {badges ? <div className="series-meta-row">{badges}</div> : null}
          <h1 className="series-name">{name}</h1>
          {seasonLine ? <p className="series-season">{seasonLine}</p> : null}
          {sub && <div className="series-sub">{sub}</div>}
          <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {user && (
              <button className={`btn ${isSaved ? 'btn-secondary' : 'btn-primary'}`} onClick={toggleSave} disabled={saving}>
                <Icon name="bookmark" size={15} fill={isSaved ? 'currentColor' : 'none'} />
                {isSaved ? 'Saved in Library' : 'Save to Library'}
              </button>
            )}
            {isAdmin && manageId != null && (
              <Link className="btn btn-secondary" to={`/manage/series/${manageId}`}>
                <Icon name="gear" size={15} />
                Library settings
              </Link>
            )}
          </div>
        </div>
      </div>
      <div className="series-body">
        <div>{children}</div>
        <aside>
          {overview && (
            <div className="panel" style={{ padding: 18 }}>
              <div className="h-eyebrow">Synopsis</div>
              <p className="synopsis">{overview}</p>
            </div>
          )}
        </aside>
      </div>
    </main>
  )
}

export default function Title() {
  const { id = '' } = useParams()
  const { user, loading: authLoading } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const seasonQ = searchParams.get('season')
  const seasonParam = seasonQ != null && seasonQ !== '' ? Number(seasonQ) : null
  const [data, setData] = useState<TitleDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [progMap, setProgMap] = useState<Record<string, Progress>>({})

  // Only a title change blanks the page; a season swap keeps the current data
  // on screen (dimmed) while the new season loads, so nothing unmounts — the
  // hero, poster, and the save button's state all stay put.
  useEffect(() => { setData(null) }, [id])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    getTitle(id, seasonParam != null && Number.isFinite(seasonParam) ? seasonParam : null)
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id, seasonParam])

  // Episode-row progress bars (same source as the player sidebar).
  useEffect(() => {
    if (!data || authLoading || data.type !== 'series') return
    const ids = data.episodes.map((ep) => ep.id).filter((eid): eid is string => !!eid)
    if (ids.length === 0) { setProgMap({}); return }
    let alive = true
    loadProgressMap(ids, !!user).then((m) => { if (alive) setProgMap(m) })
    return () => { alive = false }
  }, [data, user, authLoading])

  if (error) {
    return <PortalLayout crumb={BackCrumb}><main><p className="empty">{error}</p></main></PortalLayout>
  }
  if (!data) {
    return <PortalLayout crumb={BackCrumb}><main><p className="empty">Loading…</p></main></PortalLayout>
  }

  if (data.type === 'series') {
    const playableCount = data.episodes.filter((ep) => ep.id).length
    const seasons = data.seasons ?? []
    const season = data.season ?? null
    const seasonList = data.seasonList
      ?? seasons.map((s) => ({ season: s, name: `Season ${s}`, episodes: 0, year: null, displayTitle: null }))
    const multiSeason = seasonList.length > 1
    const activeSeason = season != null ? seasonList.find((s) => s.season === season) ?? null : null
    // A JF season name only says something when it isn't the generic "Season 3"
    // (JoJo's "Stardust Crusaders", "Final Season").
    const namedSeason = activeSeason && activeSeason.name !== `Season ${activeSeason.season}` ? activeSeason.name : null
    // The season line under the title, in precedence order:
    //  1. the admin's own override ("Season 1 Part 2") — hand-authored, always wins;
    //  2. a real JF season name ("Stone Ocean");
    //  3. the generic "Season N" — and nothing at all for a season 1 / a show with
    //     no seasons, where "Season 1" is just noise under the series name.
    const seasonLine = activeSeason?.displayTitle?.trim()
      || namedSeason
      || (season != null && season !== 1 ? `Season ${season}` : null)
    // A franchise's cours can air years apart (JoJo runs 2012-2022) — the selected
    // season's own year beats the series-level one whenever the server knows it.
    const displayYear = activeSeason?.year ?? data.year

    const subParts: string[] = []
    if (data.genres.length) subParts.push(data.genres.slice(0, 3).join(' · '))
    if (displayYear) subParts.push(String(displayYear))
    const sub = subParts.join('  ·  ')

    return (
      <PortalLayout crumb={BackCrumb}>
        <DetailShell
          id={data.id} name={data.name} seasonLine={seasonLine} sub={sub} overview={data.overview} manageId={data.manageId}
          poster={multiSeason && season != null ? seasonImgUrl(data.id, season) : undefined}
          backdrop={multiSeason && season != null ? backdropUrl(data.id, season) : undefined}
        >
          {multiSeason ? (
            <div className="season-strip">
              {seasonList.map((s) => (
                <button
                  key={s.season}
                  type="button"
                  className="season-card"
                  data-active={season === s.season}
                  onClick={() => setSearchParams(s.season === seasons[seasons.length - 1] ? {} : { season: String(s.season) })}
                >
                  <img
                    src={seasonImgUrl(data.id, s.season)} alt="" loading="lazy"
                    onError={(e) => {
                      const img = e.currentTarget
                      if (img.dataset.fallback) { img.remove(); return }
                      img.dataset.fallback = '1'
                      img.src = imgUrl(data.id)
                    }}
                  />
                  <span className="season-scrim" />
                  <span className="season-info">
                    <span className="season-name">{s.name}</span>
                    {s.episodes > 0 && <span className="season-eps">{s.episodes} eps</span>}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {/* The chase status sits after the spacer, so it grows into the empty
              right end of the head instead of pushing anything — it appears and
              disappears (and its "airs in 2d 19h" retimes) with zero shift. */}
          <div className="ep-head">
            <h2 className="k-h3">Episodes</h2>
            <span className="badge badge-mono">{playableCount}</span>
            <div className="spacer" />
            {data.nextEpisode ? (
              <span className="ep-head-chase">
                <EpisodeStatus chase={data.nextEpisode} prefix />
              </span>
            ) : null}
          </div>
          <div className="panel" style={{ overflow: 'hidden', opacity: loading ? 0.55 : 1, transition: 'opacity .15s' }}>
            <div className="eplist">
              {data.episodes.length === 0
                ? <p className="empty">No episodes found.</p>
                : data.episodes.map((ep) => {
                  if (!ep.id) {
                    return (
                      <div key={`chase-${ep.num}`} className="eprow chasing">
                        <span className="num">{ep.num}</span>
                        <span className="et">{ep.name}</span>
                        <span className="ep-status-slot">
                          <EpisodeStatus
                            chase={{
                              episode: data.nextEpisode?.episode ?? 0,
                              state: (ep.status as ChaseState) ?? data.nextEpisode?.state ?? 'waiting',
                              airsAt: ep.airsAt ?? data.nextEpisode?.airsAt ?? null,
                            }}
                          />
                        </span>
                      </div>
                    )
                  }
                  const prog = progMap[ep.id]
                  const watched = !!prog?.watched
                  const pct = watched ? 100
                    : prog && prog.duration > 0 ? Math.min(100, (prog.position / prog.duration) * 100) : 0
                  return (
                    <Link
                      key={ep.id}
                      className={`eprow${watched ? ' watched' : ''}`}
                      to={`/watch/${ep.id}`}
                    >
                      <span className="num">{ep.num}</span>
                      <span className="et">{ep.name}</span>
                      <WatchedToggle
                        id={ep.id}
                        watched={watched}
                        onChange={(eid, prog) => setProgMap((m) => ({ ...m, [eid]: prog }))}
                      />
                      <span className="go"><Icon name="play" size={13} fill="currentColor" /></span>
                      {pct > 0 && <span className="epprog" style={{ width: `${pct.toFixed(1)}%` }} />}
                    </Link>
                  )
                })}
            </div>
          </div>
        </DetailShell>
      </PortalLayout>
    )
  }

  const subParts: string[] = []
  if (data.genres.length) subParts.push(data.genres.slice(0, 3).join(' · '))
  if (data.year) subParts.push(String(data.year))
  const sub = subParts.join('  ·  ')

  const mins = data.runtimeMin
  const badges = (
    <>
      <span className="badge"><span className="dot dot-airing" />Movie</span>
      {mins && <span className="badge badge-mono badge-square">{mins} min</span>}
    </>
  )
  return (
    <PortalLayout crumb={BackCrumb}>
      <DetailShell id={data.id} name={data.name} badges={badges} sub={sub} overview={data.overview}>
        <div className="ep-head">
          <h2 className="k-h3">Feature film</h2>
          <div className="spacer" />
        </div>
        <div className="panel" style={{ padding: 22, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <Link className="btn btn-primary" to={`/watch/${data.id}`}><Icon name="play" size={15} fill="currentColor" /> Play movie</Link>
          <span className="font-mono" style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{mins ? `${mins} min · ` : ''}HLS stream</span>
        </div>
      </DetailShell>
    </PortalLayout>
  )
}

