import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Icon } from '@/components/Icon'
import { PortalLayout, BackCrumb } from '@/components/PortalLayout'
import { getTitle, imgUrl, type TitleDetail } from '@/lib/api'

const initials = (n: string) =>
  String(n || '?').split(/[^a-z0-9]/i).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase()

function DetailShell({
  id, name, badges, sub, overview, children,
}: { id: string; name: string; badges: ReactNode; sub?: string; overview?: string; children: ReactNode }) {
  return (
    <main>
      <div className="hero">
        <div className="backdrop" style={{ backgroundImage: `url('${imgUrl(id)}')` }} />
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
  const [data, setData] = useState<TitleDetail | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setData(null); setError('')
    getTitle(id).then(setData).catch((e: Error) => setError(e.message))
  }, [id])

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
    const badges = (
      <>
        <span className="badge"><span className="dot dot-info" />Series</span>
        <span className="badge badge-mono badge-square">{data.episodes.length} eps</span>
      </>
    )
    return (
      <PortalLayout crumb={BackCrumb}>
        <DetailShell id={data.id} name={data.name} badges={badges} sub={sub} overview={data.overview}>
          <div className="ep-head">
            <h2 className="k-h3">Episodes</h2>
            <span className="badge badge-mono">{data.episodes.length}</span>
            <div className="spacer" />
          </div>
          <div className="panel" style={{ overflow: 'hidden' }}>
            <div className="eplist">
              {data.episodes.length === 0
                ? <p className="empty">No episodes found.</p>
                : data.episodes.map((ep) => (
                  <Link key={ep.id} className="eprow" to={`/watch/${ep.id}`}>
                    <span className="num">{ep.num}</span>
                    <span className="et">{ep.name}</span>
                    <span className="go"><Icon name="play" size={13} fill="currentColor" /></span>
                  </Link>
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
