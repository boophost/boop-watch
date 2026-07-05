import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PortalLayout } from '@/components/PortalLayout'
import { Icon } from '@/components/Icon'
import { getSavedAnimes, loadCatalog, getWatch, imgUrl, type CatalogItem, type WatchData } from '@/lib/api'
import { supabase } from '@/lib/supabase'

export default function PersonalLibrary() {
  const [savedIds, setSavedIds] = useState<string[]>([])
  const [historyIds, setHistoryIds] = useState<string[]>([])
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [historyDetails, setHistoryDetails] = useState<Record<string, WatchData>>({})
  
  useEffect(() => {
    loadCatalog().then(c => setCatalog(c.items)).catch(console.error)
    getSavedAnimes().then(r => setSavedIds(r.saved.map(s => s.item_id))).catch(console.error)
    supabase.from('watch_progress')
      .select('item_id')
      .order('updated_at', { ascending: false })
      .limit(20)
      .then(({ data, error }) => {
        if (error) console.error(error)
        else if (data) {
          const ids = data.map((r: any) => r.item_id)
          setHistoryIds(ids)
          ids.forEach((id: string) => {
            getWatch(id).then(wd => setHistoryDetails(prev => ({ ...prev, [id]: wd }))).catch(() => {})
          })
        }
      })
  }, [])

  const savedItems = catalog.filter(c => savedIds.includes(c.id))

  return (
    <PortalLayout>
      <main>
        <section className="home-section">
          <div className="section-head">
            <h1 className="k-h1">Personal Library</h1>
          </div>
          
          <div className="h-eyebrow" style={{ marginTop: '2rem', marginBottom: '1rem' }}>Saved Anime</div>
          {savedItems.length === 0 ? (
            <div className="empty"><p>You haven't saved any titles yet.</p></div>
          ) : (
            <div className="grid">
              {savedItems.map(it => (
                <Link key={it.id} className="poster-card" to={it.type === 'Series' ? `/series/${it.id}` : `/movie/${it.id}`}>
                  <img src={imgUrl(it.id)} loading="lazy" alt="" onError={(e) => e.currentTarget.remove()} />
                  <span className="type-tag"><Icon name={it.type === 'Series' ? 'tv' : 'film'} size={11} />{it.type === 'Series' ? 'Series' : 'Movie'}</span>
                  <div className="poster-overlay">
                    <div className="poster-title">{it.name}</div>
                  </div>
                </Link>
              ))}
            </div>
          )}

          <div className="h-eyebrow" style={{ marginTop: '3rem', marginBottom: '1rem' }}>Recently Watched</div>
          {historyIds.length === 0 ? (
            <div className="empty"><p>No watch history.</p></div>
          ) : (
            <div className="grid">
              {historyIds.map(id => {
                const data = historyDetails[id]
                return (
                  <Link key={id} className="poster-card" to={`/watch/${id}`}>
                    <img src={imgUrl(id)} loading="lazy" alt="" onError={(e) => e.currentTarget.remove()} />
                    <span className="type-tag"><Icon name="play" size={11} />Watched</span>
                    <div className="poster-overlay">
                      <div className="poster-title">{data ? data.title : 'Loading...'}</div>
                      {data && <div className="poster-meta"><span>{data.isEpisode ? `Episode ${data.epNum}` : 'Movie'}</span></div>}
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </section>
      </main>
    </PortalLayout>
  )
}

