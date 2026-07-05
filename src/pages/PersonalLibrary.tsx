import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PortalLayout } from '@/components/PortalLayout'
import { Icon } from '@/components/Icon'
import { getSavedAnimes, loadCatalog, getWatch, imgUrl, type CatalogItem, type WatchData } from '@/lib/api'
import { supabase } from '@/lib/supabase'

export default function PersonalLibrary() {
  const [savedIds, setSavedIds] = useState<string[]>([])
  const [historyItems, setHistoryItems] = useState<{ id: string; position: number; duration: number; watched: boolean }[]>([])
  const [historyPage, setHistoryPage] = useState(0)
  const [historyTotal, setHistoryTotal] = useState(0)
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [historyDetails, setHistoryDetails] = useState<Record<string, WatchData>>({})
  
  useEffect(() => {
    loadCatalog().then(c => setCatalog(c.items)).catch(console.error)
    getSavedAnimes().then(r => setSavedIds(r.saved.map(s => s.item_id))).catch(console.error)
  }, [])

  useEffect(() => {
    supabase.from('watch_progress')
      .select('item_id, position, duration, watched', { count: 'exact' })
      .order('updated_at', { ascending: false })
      .range(historyPage * 20, historyPage * 20 + 19)
      .then(({ data, error, count }) => {
        if (error) console.error(error)
        else if (data) {
          if (count != null) setHistoryTotal(count)
          const items = data.map((r: any) => ({
            id: r.item_id,
            position: r.position,
            duration: r.duration,
            watched: r.watched
          }))
          setHistoryItems(items)
          items.forEach(it => {
            getWatch(it.id).then(wd => setHistoryDetails(prev => ({ ...prev, [it.id]: wd }))).catch(() => {})
          })
        }
      })
  }, [historyPage])

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

          <div className="h-eyebrow" style={{ marginTop: '3rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Recently Watched</span>
            {historyTotal > 20 && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <button 
                  className="btn" 
                  disabled={historyPage === 0} 
                  onClick={() => setHistoryPage(p => p - 1)}>
                  Prev
                </button>
                <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                  Page {historyPage + 1} of {Math.ceil(historyTotal / 20)}
                </span>
                <button 
                  className="btn" 
                  disabled={(historyPage + 1) * 20 >= historyTotal} 
                  onClick={() => setHistoryPage(p => p + 1)}>
                  Next
                </button>
              </div>
            )}
          </div>
          {historyItems.length === 0 ? (
            <div className="empty"><p>No watch history.</p></div>
          ) : (
            <div className="grid">
              {historyItems.map(it => {
                const data = historyDetails[it.id]
                const title = data ? (data.isEpisode ? data.back.label : data.title) : 'Loading...'
                const epText = data && data.isEpisode ? (data.epNum ? `Episode ${data.epNum}: ${data.title}` : data.title) : 'Movie'
                const pct = it.watched ? 100 : (it.duration > 0 ? Math.min(100, (it.position / it.duration) * 100) : 0)

                return (
                  <Link key={it.id} className="poster-card" to={`/watch/${it.id}`}>
                    <img src={imgUrl(it.id)} loading="lazy" alt="" onError={(e) => e.currentTarget.remove()} />
                    <span className="type-tag"><Icon name="play" size={11} />Watched</span>
                    <div className="poster-overlay">
                      <div className="poster-title">{title}</div>
                      {data && <div className="poster-meta"><span>{epText}</span></div>}
                    </div>
                    {pct > 0 && (
                      <div style={{ position: 'absolute', bottom: 0, left: 0, height: 4, backgroundColor: 'var(--accent)', width: `${pct}%`, zIndex: 10 }} />
                    )}
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

