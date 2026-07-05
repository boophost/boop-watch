import { jfJson, JfItem } from './jellyfin.js'
import { getPortalDb, upsertPortalItem, PortalItem, getPortalItem } from './portalDb.js'
import { listSeries } from './db.js'
import { searchAnime, pickPosterUrl } from './jikan.js'

const COLLECTION_ID = process.env.WATCH_COLLECTION_ID

export async function syncJellyfinToPortal() {
  if (!COLLECTION_ID) return

  const children = await jfJson<{ Items?: JfItem[] }>('/Items', {
    ParentId: COLLECTION_ID,
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    Fields: 'PrimaryImageAspectRatio,ProductionYear,Genres,OriginalTitle,DateCreated,PremiereDate,Overview,RunTimeTicks',
  })
  
  const items = children.Items || []
  const dbSeries = listSeries()
  const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

  for (const it of items) {
    const existing = getPortalItem(it.Id)
    let imageUrl = existing?.image_url || null
    let backdropUrl = existing?.backdrop_url || null

    if (!imageUrl && !it.PrimaryImageAspectRatio) {
      const match = dbSeries.find(s => norm(s.title) === norm(it.Name || '') || norm(s.title) === norm(it.OriginalTitle || ''))
      if (match && match.image_url) {
        imageUrl = match.image_url
      } else {
        try {
          const jikanRes = await searchAnime(it.Name || '', 1)
          if (jikanRes.length > 0) {
             imageUrl = pickPosterUrl(jikanRes[0])
          }
          await new Promise(r => setTimeout(r, 1000)) // 1 second delay to avoid Jikan rate limit
        } catch (e) {
          console.error("Jikan search error:", e)
        }
      }
    }

    const pItem: PortalItem = {
      id: it.Id,
      type: it.Type || 'Movie',
      name: it.Name || '',
      original_title: it.OriginalTitle || null,
      overview: it.Overview || null,
      date_created: it.DateCreated || null,
      premiere_date: it.PremiereDate || null,
      production_year: it.ProductionYear || null,
      genres: it.Genres ? JSON.stringify(it.Genres) : null,
      runtime_ticks: it.RunTimeTicks || null,
      index_number: it.IndexNumber ?? null,
      parent_index_number: it.ParentIndexNumber ?? null,
      series_id: it.SeriesId || null,
      series_name: it.SeriesName || null,
      image_url: imageUrl,
      backdrop_url: backdropUrl
    }
    upsertPortalItem(pItem)

    if (it.Type === 'Series') {
      const eps = await jfJson<{ Items?: JfItem[] }>(`/Shows/${it.Id}/Episodes`, { Fields: 'Overview,DateCreated,PremiereDate,RunTimeTicks' })
      for (const ep of eps.Items || []) {
        const epExisting = getPortalItem(ep.Id)
        const pEp: PortalItem = {
          id: ep.Id,
          type: ep.Type || 'Episode',
          name: ep.Name || '',
          original_title: ep.OriginalTitle || null,
          overview: ep.Overview || null,
          date_created: ep.DateCreated || null,
          premiere_date: ep.PremiereDate || null,
          production_year: ep.ProductionYear || null,
          genres: null,
          runtime_ticks: ep.RunTimeTicks || null,
          index_number: ep.IndexNumber ?? null,
          parent_index_number: ep.ParentIndexNumber ?? null,
          series_id: it.Id,
          series_name: it.Name || null,
          image_url: epExisting?.image_url || null,
          backdrop_url: epExisting?.backdrop_url || null
        }
        upsertPortalItem(pEp)
      }
    }
  }
}
