import { jfJson, JfItem } from './jellyfin.js'
import { getPortalDb, upsertPortalItem, PortalItem, getPortalItem } from './portalDb.js'
import {
  listSeries, SeriesRow, EpisodeRow,
  countCachedEpisodes, getEpisodeTitles, upsertEpisodes,
} from './db.js'
import { searchAnime, pickPosterUrl, fetchAnimeEpisodesPage, episodeNumberFromUrl } from './jikan.js'
import { ensureSeriesBanners } from './banners.js'

const COLLECTION_ID = process.env.WATCH_COLLECTION_ID

const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
// A Jellyfin folder/title often carries a trailing "(2023)" the catalog title lacks.
const stripYear = (s: string) => s.replace(/\s*\(\d{4}\)\s*$/, '')

// Match a Jellyfin item to a catalog series by any of its title variants
// (romaji / english / japanese), so we can borrow the catalog's clean names.
function matchCatalog(it: JfItem, catalog: SeriesRow[]): SeriesRow | undefined {
  const cands = [norm(stripYear(it.Name || '')), norm(it.OriginalTitle || '')].filter(Boolean)
  if (cands.length === 0) return undefined
  return catalog.find((s) => {
    const titles = [s.title, s.title_english, s.title_japanese]
      .filter((t): t is string => !!t)
      .map(norm)
      .filter(Boolean)
    return titles.some((t) => cands.includes(t))
  })
}

// MAL episode titles for a series, cached in the catalog DB. Fetches from Jikan
// only the first time (paginated); best-effort — returns whatever is cached on
// error so a Jikan hiccup never breaks the portal sync.
async function ensureEpisodeTitles(mal_id: number): Promise<Map<number, string>> {
  if (countCachedEpisodes(mal_id) > 0) return getEpisodeTitles(mal_id)
  try {
    const rows: EpisodeRow[] = []
    for (let page = 1; page <= 20; page++) {
      const { episodes, pagination } = await fetchAnimeEpisodesPage(mal_id, page)
      for (const e of episodes) {
        const number = episodeNumberFromUrl(e.url)
        if (number != null) rows.push({ number, title: e.title, title_japanese: e.title_japanese ?? null, aired: e.aired ?? null })
      }
      if (!pagination?.has_next_page) break
      await new Promise((r) => setTimeout(r, 400)) // be polite to Jikan between pages
    }
    if (rows.length) upsertEpisodes(mal_id, rows)
  } catch (e) {
    console.error('episode-title fetch failed for mal', mal_id, e)
  }
  return getEpisodeTitles(mal_id)
}

export async function syncJellyfinToPortal() {
  if (!COLLECTION_ID) return

  const children = await jfJson<{ Items?: JfItem[] }>('/Items', {
    ParentId: COLLECTION_ID,
    Recursive: 'true',
    IncludeItemTypes: 'Movie,Series',
    Fields: 'PrimaryImageAspectRatio,BackdropImageTags,ProductionYear,Genres,OriginalTitle,DateCreated,PremiereDate,Overview,RunTimeTicks',
  })

  const items = children.Items || []
  const dbSeries = listSeries()

  for (const it of items) {
    const existing = getPortalItem(it.Id)
    let imageUrl = existing?.image_url || null
    let backdropUrl = existing?.backdrop_url || null

    // A catalog hit lets us use its clean title (and episode titles below) and
    // its poster; Jellyfin's own name/art is the fallback.
    const match = matchCatalog(it, dbSeries)
    const displayName = match?.title_english || match?.title || it.Name || ''

    // Gather wide season-banner candidates (AniList/Kitsu) once per series; the
    // portal serves whichever candidate the admin has selected (see banners.ts).
    if (match) {
      try { await ensureSeriesBanners(match.mal_id) } catch (e) { console.error('banner gather failed', e) }
    }

    if (!imageUrl && !it.PrimaryImageAspectRatio) {
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
      name: displayName,
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
      backdrop_url: backdropUrl,
      has_backdrop: (it.BackdropImageTags && it.BackdropImageTags.length > 0) ? 1 : 0,
      mal_id: match?.mal_id ?? null,
    }
    upsertPortalItem(pItem)

    if (it.Type === 'Series') {
      // Clean per-episode titles from MAL (cached), mapped by episode number.
      const epTitles = match ? await ensureEpisodeTitles(match.mal_id) : new Map<number, string>()
      const eps = await jfJson<{ Items?: JfItem[] }>(`/Shows/${it.Id}/Episodes`, { Fields: 'Overview,DateCreated,PremiereDate,RunTimeTicks' })
      for (const ep of eps.Items || []) {
        const epExisting = getPortalItem(ep.Id)
        // Absolute MAL numbering lines up with the main season; leave specials
        // (season 0) and any unmapped number on Jellyfin's name.
        const mainSeason = ep.ParentIndexNumber == null || ep.ParentIndexNumber === 1
        const malTitle = mainSeason && ep.IndexNumber != null ? epTitles.get(ep.IndexNumber) : undefined
        const pEp: PortalItem = {
          id: ep.Id,
          type: ep.Type || 'Episode',
          name: malTitle || ep.Name || '',
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
          series_name: displayName || null,
          image_url: epExisting?.image_url || null,
          backdrop_url: epExisting?.backdrop_url || null,
          has_backdrop: (ep.BackdropImageTags && ep.BackdropImageTags.length > 0) ? 1 : 0,
          mal_id: null,
        }
        upsertPortalItem(pEp)
      }
    }
  }
}
