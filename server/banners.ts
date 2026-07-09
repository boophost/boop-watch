// Season-banner candidate gathering. Wide banner art doesn't come from MAL/Jikan,
// so we pull it from four sources — AniList `bannerImage`, Kitsu `coverImage`,
// every image provider Jellyfin has configured (TheTVDB / TheMovieDb today), and
// fanart.tv — store each as a candidate alongside any admin uploads, and
// auto-select a default. Admins pick among them on the series page.
//
// Candidates are *additive*: re-gathering only ever inserts new URLs — it never
// deletes a candidate or moves the admin's selection.
//
// Only the **selected** candidate is copied into BANNERS_DIR, so the art the
// portal serves can't move or 404 under us. The rest stay as remote URLs the
// picker hotlinks: the provider catalogs run to dozens of images per cour, and
// caching all of them would run the (1Gi, shared with series.sqlite) data volume
// out of space.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fetchAniListBanner } from './anilist.js'
import { fetchFanartArt } from './fanart.js'
import { addBanner, getSelectedBanner, listBanners, listSeries, selectBanner, setBannerLocalFile, BannerRow, SeriesRow } from './db.js'
import { limitedFetch } from './httpQueue.js'
import { getSeriesSeasons, jellyfinConfigured, jfRemoteImages, jfSeriesIdByTvdb } from './jellyfin.js'

/** Banner files (uploads + cached remote art) live under DATA_DIR/banners. */
export const BANNERS_DIR = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'), 'banners')

export const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif',
}

// Kitsu's wide coverImage, resolved from a MAL id via Kitsu's mappings table.
async function fetchKitsuCover(malId: number): Promise<{ url: string; width: number | null; height: number | null } | null> {
  try {
    const res = await limitedFetch(
      'kitsu',
      `https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&include=item`,
      { headers: { Accept: 'application/vnd.api+json' } },
    )
    if (!res.ok) return null
    const json = (await res.json()) as {
      included?: Array<{ attributes?: { coverImage?: { large?: string; original?: string; meta?: { dimensions?: { large?: { width: number; height: number } } } } } }>
    }
    const cover = json.included?.[0]?.attributes?.coverImage
    const url = cover?.large || cover?.original
    if (!url) return null
    const dim = cover?.meta?.dimensions?.large
    return { url, width: dim?.width ?? null, height: dim?.height ?? null }
  } catch {
    return null
  }
}

// Jellyfin names its providers for humans; we want a short, filename-safe tag.
const PROVIDER_SLUGS: Record<string, string> = { thetvdb: 'tvdb', themoviedb: 'tmdb' }

function providerSource(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return PROVIDER_SLUGS[slug] ?? slug
}

// TheMovieDb returns no ThumbnailUrl and its backdrops run to 4K (~1.3MB each),
// so drawing a picker of twenty would fetch ~30MB of full-size art. Its CDN
// renders a size per path segment; w780 is ~105KB. TheTVDB gives us a real
// ThumbnailUrl, so only TMDB needs this.
const TMDB_ORIGINAL = 'https://image.tmdb.org/t/p/original/'

function deriveThumb(url: string): string | null {
  return url.startsWith(TMDB_ORIGINAL) ? url.replace('/t/p/original/', '/t/p/w780/') : null
}

// Auto-select preference. AniList's banner stays first: it is the only source
// drawn as a true wide banner rather than a 16:9 still, and keeping it on top
// means adding the provider catalogs doesn't silently restyle every cour's hero.
// An unranked source sorts last — `indexOf` would have sorted it *first* (-1).
const SOURCE_RANK: Record<string, number> = { anilist: 0, kitsu: 1, tvdb: 2, tmdb: 3, fanart: 4, upload: 5 }
const sourceRank = (source: string): number => SOURCE_RANK[source] ?? 90

// Pick the default when nothing is selected yet. Ties keep insertion order
// (a stable sort over listBanners' `id ASC`), so season-specific art — gathered
// before the show-wide pool — wins over its own source's series backdrops.
function autoSelect(mal_id: number): void {
  if (getSelectedBanner(mal_id)) return
  const rows = listBanners(mal_id)
  if (rows.length === 0) return
  const pick = rows.slice().sort((a, b) => sourceRank(a.source) - sourceRank(b.source))[0]
  selectBanner(mal_id, pick.id)
}

interface Candidate {
  source: string
  url: string
  thumb_url: string | null
  width: number | null
  height: number | null
}

/**
 * Wide art from the artwork databases keyed by tvdb id: everything Jellyfin's
 * own image providers offer, plus fanart.tv. Season-scoped art is returned
 * first so it outranks the show-wide pool.
 *
 * Best-effort per source — one catalog being down still yields the other's art.
 */
async function gatherProviderArt(row: SeriesRow, tvdbId: number): Promise<Candidate[]> {
  const season = row.tvdb_season
  const out: Candidate[] = []

  if (jellyfinConfigured) {
    try {
      const seriesId = await jfSeriesIdByTvdb(tvdbId)
      if (seriesId) {
        const items: string[] = []
        if (season != null) {
          const seasonItem = (await getSeriesSeasons(seriesId)).find((s) => s.IndexNumber === season)
          if (seasonItem) items.push(seasonItem.Id)
        }
        items.push(seriesId)
        for (const itemId of items) {
          for (const img of await jfRemoteImages(itemId)) {
            out.push({
              source: providerSource(img.provider),
              url: img.url,
              thumb_url: img.thumbUrl ?? deriveThumb(img.url),
              width: img.width,
              height: img.height,
            })
          }
        }
      }
    } catch (e) {
      console.error(`jellyfin banner gather failed for tvdb ${tvdbId} —`, e)
    }
  }

  const fanart = await fetchFanartArt(tvdbId)
  const fanartRows = [
    ...(season == null ? [] : fanart.seasonThumbs.filter((i) => i.season === season)),
    ...fanart.backgrounds,
  ]
  for (const img of fanartRows) {
    out.push({ source: 'fanart', url: img.url, thumb_url: img.thumbUrl, width: null, height: null })
  }

  return out
}

const MAX_BANNER_BYTES = 12 * 1024 * 1024

/**
 * Copy a candidate's remote art into BANNERS_DIR so the portal never depends on
 * the source CDN. The name is derived from the URL, so re-caching the same
 * candidate rewrites the same file. Best-effort: a failure leaves `local_file`
 * unset and `serveBanner` falls back to the remote URL.
 *
 * A row whose recorded file has gone missing (a wiped volume) is re-fetched, so
 * losing BANNERS_DIR heals on the next gather rather than stranding us on the
 * remote URL forever.
 */
async function cacheBannerFile(b: BannerRow): Promise<void> {
  if (!b.url) return
  if (b.local_file && fs.existsSync(path.join(BANNERS_DIR, path.basename(b.local_file)))) return
  try {
    const res = await limitedFetch('other', b.url)
    if (!res.ok) return
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    const ext = EXT_BY_TYPE[type] ?? path.extname(new URL(b.url).pathname).replace('.', '').toLowerCase()
    if (!Object.values(EXT_BY_TYPE).includes(ext)) return
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length === 0 || body.length > MAX_BANNER_BYTES) return

    const digest = crypto.createHash('sha1').update(b.url).digest('hex').slice(0, 10)
    const file = `${b.mal_id}-${b.source}-${digest}.${ext}`
    fs.mkdirSync(BANNERS_DIR, { recursive: true })
    fs.writeFileSync(path.join(BANNERS_DIR, file), body)
    setBannerLocalFile(b.id, file)
  } catch {
    /* keep the remote URL as the fallback */
  }
}

// Remote sources are re-queried on this cadence so art added later (Kitsu often
// lags a new season by weeks) still shows up. Anything already stored stays —
// `addBanner` dedupes by URL, so a re-query only inserts genuinely new art.
const REGATHER_MS = 6 * 60 * 60 * 1000
// `${mal_id}:${source}` -> last attempt. In-process only: a restart re-queries
// once, which is cheap and self-healing.
const lastTried = new Map<string, number>()

function due(mal_id: number, source: string): boolean {
  const key = `${mal_id}:${source}`
  const last = lastTried.get(key) ?? 0
  if (Date.now() - last < REGATHER_MS) return false
  lastTried.set(key, Date.now())
  return true
}

/** Copy the art the portal actually serves onto the data volume. */
export async function cacheSelectedBanner(mal_id: number): Promise<void> {
  const selected = getSelectedBanner(mal_id)
  if (selected) await cacheBannerFile(selected)
}

/**
 * Ensure a series has its banner candidates gathered, and its selected one
 * cached on disk. Idempotent, additive, and best-effort: each source failure is
 * ignored, no candidate is ever removed, and the admin's selection is never
 * reassigned. Returns the current candidate list.
 */
export async function ensureSeriesBanners(mal_id: number): Promise<BannerRow[]> {
  const row = listSeries().find((s) => s.mal_id === mal_id)
  const tvdbId = row?.tvdb_id ?? null

  // `due` records the attempt, so it must be reached only when we'd really try.
  const [anilist, kitsu, providers] = await Promise.all([
    due(mal_id, 'anilist') ? fetchAniListBanner(mal_id).catch(() => null) : null,
    due(mal_id, 'kitsu') ? fetchKitsuCover(mal_id).catch(() => null) : null,
    row && tvdbId != null && due(mal_id, 'providers')
      ? gatherProviderArt(row, tvdbId).catch(() => [] as Candidate[])
      : ([] as Candidate[]),
  ])
  if (anilist) addBanner({ mal_id, source: 'anilist', url: anilist })
  if (kitsu) addBanner({ mal_id, source: 'kitsu', url: kitsu.url, width: kitsu.width, height: kitsu.height })
  for (const c of providers) addBanner({ mal_id, ...c })

  autoSelect(mal_id)
  await cacheSelectedBanner(mal_id)
  return listBanners(mal_id)
}

/**
 * Same, for every cour of the franchise. The portal's per-season hero
 * (`/img/:id/backdrop?season=N`) reads the banner of *that season's* catalog
 * cour, but a Jellyfin series matches only one cour — so gathering just that
 * one leaves every other season's art uncached and still hotlinked.
 */
export async function ensureFranchiseBanners(mal_id: number): Promise<void> {
  await ensureSeriesBanners(mal_id)
  const rows = listSeries()
  const seed = rows.find((s) => s.mal_id === mal_id)
  if (seed?.tvdb_id == null) return
  for (const sibling of rows) {
    if (sibling.mal_id === mal_id || sibling.tvdb_id !== seed.tvdb_id) continue
    try {
      await ensureSeriesBanners(sibling.mal_id)
    } catch (e) {
      console.error(`banner gather failed for cour ${sibling.mal_id} —`, e)
    }
  }
}
