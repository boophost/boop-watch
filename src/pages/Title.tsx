import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Icon } from '@/components/Icon'
import { EpisodeStatus } from '@/components/EpisodeStatus'
import { PortalLayout, BackCrumb } from '@/components/PortalLayout'
import { getTitle, imgUrl, backdropUrl, saveAnime, unsaveAnime, getSavedAnimes, type TitleDetail } from '@/lib/api'
import type { ChaseState } from '@/lib/chase'
import { useAuth } from '@/lib/AuthContext'
import { track } from '@/lib/analytics'

const initials = (n: string) =>
  String(n || '?').split(/[^a-z0-9]/i).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase()

function DetailShell({
  id, name, badges, sub, overview, manageId, children,
}: { id: string; name: string; badges: ReactNode; sub?: string; overview?: string; manageId?: number | null; children: ReactNode }) {
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
        <div className="backdrop" style={{ backgroundImage: `url('${backdropUrl(id)}')` }} />
        <div className="scrim" />
      </div>
      <div className="series-head">
        <div className="series-poster">
          <div className="poster-fallback" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontFamily: 'var(--font-mono)', color: 'oklch(1 0 0 / 55%)' }}>
            {initials(name)}
          </div>
          <img src={imgUrl(id)} alt="" onError={(e) => e.currentTarget.remove()} />
        </div>
        <div style={{ paddingBottom: 6 }}>
          <div className="series-meta-row">{badges}</div>
          <h1 className="k-h1" style={{ fontSize: 32 }}>{name}</h1>
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
  const [searchParams, setSearchParams] = useSearchParams()
  const seasonQ = searchParams.get('season')
  const seasonParam = seasonQ != null && seasonQ !== '' ? Number(seasonQ) : null
  const [data, setData] = useState<TitleDetail | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setData(null); setError('')
    getTitle(id, seasonParam != null && Number.isFinite(seasonParam) ? seasonParam : null)
      .then(setData)
      .catch((e: Error) => setError(e.message))
  }, [id, seasonParam])

  if (error) {
    return <PortalLayout crumb={BackCrumb}><main><p className="empty">{error}</p></main></PortalLayout>
  }
  if (!data) {
    return <PortalLayout crumb={BackCrumb}><main><p className="empty">Loading…</p></main></PortalLayout>
  }

  const subParts: string[] = []
  if (data.genres.length) subParts.push(data.genres.slice(0, 3).join(' · '))
  if (data.year) subParts.push(String(data.year))
  const sub = subParts.join('  ·  ')

  if (data.type === 'series') {
    const playableCount = data.episodes.filter((ep) => ep.id).length
    const seasons = data.seasons ?? []
    const season = data.season ?? null
    const badges = (
      <>
        <span className="badge"><span className="dot dot-info" />Series</span>
        {season != null ? (
          <span className="badge badge-mono badge-square">S{season}</span>
        ) : null}
        <span className="badge badge-mono badge-square">{playableCount} eps</span>
        {data.nextEpisode ? (
          <span className="badge ep-chase">
            <EpisodeStatus chase={data.nextEpisode} prefix />
          </span>
        ) : null}
      </>
    )
    return (
      <PortalLayout crumb={BackCrumb}>
        <DetailShell id={data.id} name={data.name} badges={badges} sub={sub} overview={data.overview} manageId={data.manageId}>
          {seasons.length > 1 ? (
            <div className="ep-head" style={{ marginBottom: 8 }}>
              <h2 className="k-h3">Season</h2>
              <div className="spacer" />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {seasons.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`btn ${season === s ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ padding: '4px 12px', fontSize: 13 }}
                    onClick={() => setSearchParams(s === seasons[seasons.length - 1] ? {} : { season: String(s) })}
                  >
                    S{s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {(data.related?.length ?? 0) > 0 ? (
            <div className="panel" style={{ padding: 14, marginBottom: 16 }}>
              <div className="h-eyebrow">Related</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                {data.related!.map((r) => (
                  <Link key={r.id} className="chip" to={`/series/${r.id}`}>
                    {r.name}
                    <span style={{ opacity: 0.55, marginLeft: 6 }}>{r.relation}</span>
                  </Link>
                ))}
              </div>
            </div>
          ) : null}
          <div className="ep-head">
            <h2 className="k-h3">Episodes</h2>
            <span className="badge badge-mono">{playableCount}</span>
            <div className="spacer" />
          </div>
          <div className="panel" style={{ overflow: 'hidden' }}>
            <div className="eplist">
              {data.episodes.length === 0
                ? <p className="empty">No episodes found.</p>
                : data.episodes.map((ep) => (
                  ep.id ? (
                    <Link key={ep.id} className="eprow" to={`/watch/${ep.id}`}>
                      <span className="num">{ep.num}</span>
                      <span className="et">{ep.name}</span>
                      <span className="go"><Icon name="play" size={13} fill="currentColor" /></span>
                    </Link>
                  ) : (
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
                ))}
            </div>
          </div>
        </DetailShell>
      </PortalLayout>
    )
  }

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

