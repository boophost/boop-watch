import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PortalLayout } from '@/components/PortalLayout'
import { Icon } from '@/components/Icon'
import { getSavedAnimes, getItemSummaries, imgUrl, type ItemSummary } from '@/lib/api'
import { supabase } from '@/lib/supabase'

export default function PersonalLibrary() {
  const [savedItems, setSavedItems] = useState<ItemSummary[]>([])
  const [historyItems, setHistoryItems] = useState<{ id: string; position: number; duration: number; watched: boolean }[]>([])
  const [historyPage, setHistoryPage] = useState(0)
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyDetails, setHistoryDetails] = useState<Record<string, ItemSummary>>({})

  // Resolve saved-title ids to name/type in one batch call rather than pulling
  // the whole catalog and filtering it client-side.
  useEffect(() => {
    getSavedAnimes()
      .then(async r => {
        const ids = r.saved.map(s => s.item_id)
        if (!ids.length) { setSavedItems([]); return }
        const { items } = await getItemSummaries(ids)
        const byId = new Map(items.map(s => [s.id, s]))
        setSavedItems(ids.map(id => byId.get(id)).filter((s): s is ItemSummary => !!s))
      })
      .catch(console.error)
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
          // One batch metadata call for the page's rows instead of an N+1
          // getWatch() fan-out (each of which spun up a transcode probe).
          const ids = items.map(it => it.id)
          if (ids.length) {
            getItemSummaries(ids)
              .then(({ items: sums }) => setHistoryDetails(Object.fromEntries(sums.map(s => [s.id, s]))))
              .catch(() => {})
          }
        }
      })
  }, [historyPage])

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
                <Link key={it.id} className="poster-card" to={it.type === 'series' ? `/series/${it.id}` : `/movie/${it.id}`}>
                  <img src={imgUrl(it.id)} loading="lazy" alt="" onError={(e) => e.currentTarget.remove()} />
                  <span className="type-tag"><Icon name={it.type === 'series' ? 'tv' : 'film'} size={11} />{it.type === 'series' ? 'Series' : 'Movie'}</span>
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
              {historyItems.filter(it => it.watched || (it.duration > 0 && (it.position / it.duration) > 0.05)).map(it => {
                const data = historyDetails[it.id]
                const title = data ? data.name : 'Loading...'
                const epText = data ? (data.type === 'episode' ? (data.epLabel || 'Episode') : 'Movie') : ''
                const pct = it.watched ? 100 : (it.duration > 0 ? Math.min(100, (it.position / it.duration) * 100) : 0)

                return (
                  <Link key={it.id} className="poster-card" to={`/watch/${it.id}`}>
                    <img src={imgUrl(data?.seriesId || it.id)} loading="lazy" alt="" onError={(e) => e.currentTarget.remove()} />
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

