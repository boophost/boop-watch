// Season art candidate gathering, for two kinds: the wide 'banner' behind a
// season's title, and its portrait 'poster'. Neither comes from MAL/Jikan, so we
// pull them from four sources — AniList (`bannerImage` / `coverImage`), Kitsu
// (`coverImage` / `posterImage`), every image provider Jellyfin has configured
// (TheTVDB / TheMovieDb today), and fanart.tv — store each as a candidate
// alongside any admin uploads, and let admins pick on the series page.
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
import { spawn } from 'node:child_process'
import { fetchAniListArt } from './anilist.js'
import { fetchFanartArt, FanartImage } from './fanart.js'
import { addBanner, getSelectedBanner, listBanners, listSeries, selectBanner, setBannerLocalFile, ArtKind, BannerRow, SeriesRow } from './db.js'
import { limitedFetch } from './httpQueue.js'
import { getSeriesSeasons, jellyfinConfigured, jfRemoteImages, jfSeriesIdByTvdb } from './jellyfin.js'

/** Banner files (uploads + cached remote art) live under DATA_DIR/banners. */
export const BANNERS_DIR = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'), 'banners')

export const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif',
}

export const ART_KINDS: ArtKind[] = ['banner', 'poster']

interface SizedImage { url: string; width: number | null; height: number | null }

// Kitsu's wide coverImage and portrait posterImage, resolved from a MAL id via
// Kitsu's mappings table (one request serves both).
async function fetchKitsuArt(malId: number): Promise<{ cover: SizedImage | null; poster: SizedImage | null }> {
  const none = { cover: null, poster: null }
  try {
    const res = await limitedFetch(
      'kitsu',
      `https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&include=item`,
      { headers: { Accept: 'application/vnd.api+json' } },
    )
    if (!res.ok) return none
    type KitsuImage = {
      large?: string
      original?: string
      meta?: { dimensions?: { large?: { width: number; height: number } } }
    }
    const json = (await res.json()) as {
      included?: Array<{ attributes?: { coverImage?: KitsuImage; posterImage?: KitsuImage } }>
    }
    const pick = (img: KitsuImage | undefined): SizedImage | null => {
      const url = img?.large || img?.original
      if (!url) return null
      const dim = img?.meta?.dimensions?.large
      return { url, width: dim?.width ?? null, height: dim?.height ?? null }
    }
    const attrs = json.included?.[0]?.attributes
    return { cover: pick(attrs?.coverImage), poster: pick(attrs?.posterImage) }
  } catch {
    return none
  }
}

// Jellyfin names its providers for humans; we want a short, filename-safe tag.
const PROVIDER_SLUGS: Record<string, string> = { thetvdb: 'tvdb', themoviedb: 'tmdb' }

function providerSource(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return PROVIDER_SLUGS[slug] ?? slug
}

// TheMovieDb returns no ThumbnailUrl and its art runs to 4K (a backdrop is
// ~1.3MB), so drawing a picker of dozens would fetch tens of MB of full-size
// images. Its CDN renders a size per path segment. TheTVDB gives us a real
// ThumbnailUrl, so only TMDB needs this.
const TMDB_ORIGINAL = 'https://image.tmdb.org/t/p/original/'
const TMDB_THUMB_WIDTH: Record<ArtKind, string> = { banner: 'w780', poster: 'w342' }

function deriveThumb(url: string, kind: ArtKind): string | null {
  return url.startsWith(TMDB_ORIGINAL)
    ? url.replace('/t/p/original/', `/t/p/${TMDB_THUMB_WIDTH[kind]}/`)
    : null
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
//
// Banners only. A poster left unselected falls back to the season's own Jellyfin
// poster, which is already right for nearly every cour; auto-selecting one would
// silently repaint the whole browse grid the first time this runs.
function autoSelect(mal_id: number): void {
  if (getSelectedBanner(mal_id)) return
  const rows = listBanners(mal_id)
  if (rows.length === 0) return
  const pick = rows.slice().sort((a, b) => sourceRank(a.source) - sourceRank(b.source))[0]
  selectBanner(mal_id, pick.id)
}

interface Candidate {
  kind: ArtKind
  source: string
  url: string
  thumb_url: string | null
  width: number | null
  height: number | null
}

// What each kind is called in Jellyfin's RemoteImages `type`, and how deep we
// let its list run. Posters are capped harder: a popular series carries ~125
// remote posters against ~33 backdrops, and Jellyfin returns them best-first.
const JF_IMAGE_TYPE: Record<ArtKind, string> = { banner: 'Backdrop', poster: 'Primary' }
const JF_IMAGE_LIMIT: Record<ArtKind, number> = { banner: 60, poster: 30 }

const fanartSets = (sets: Awaited<ReturnType<typeof fetchFanartArt>>, kind: ArtKind) =>
  kind === 'banner'
    ? { seasonScoped: sets.seasonThumbs, showWide: sets.backgrounds }
    : { seasonScoped: sets.seasonPosters, showWide: sets.posters }

/**
 * Art from the databases keyed by tvdb id: everything Jellyfin's own image
 * providers offer, plus fanart.tv. Both kinds are gathered from one fanart
 * request. Season-scoped art comes first so it outranks the show-wide pool.
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
        for (const kind of ART_KINDS) {
          for (const itemId of items) {
            for (const img of await jfRemoteImages(itemId, JF_IMAGE_TYPE[kind], JF_IMAGE_LIMIT[kind])) {
              out.push({
                kind,
                source: providerSource(img.provider),
                url: img.url,
                thumb_url: img.thumbUrl ?? deriveThumb(img.url, kind),
                width: img.width,
                height: img.height,
              })
            }
          }
        }
      }
    } catch (e) {
      console.error(`jellyfin art gather failed for tvdb ${tvdbId} —`, e)
    }
  }

  const fanart = await fetchFanartArt(tvdbId)
  for (const kind of ART_KINDS) {
    const { seasonScoped, showWide } = fanartSets(fanart, kind)
    const rows: FanartImage[] = [
      ...(season == null ? [] : seasonScoped.filter((i) => i.season === season)),
      ...showWide,
    ]
    for (const img of rows) {
      out.push({ kind, source: 'fanart', url: img.url, thumb_url: img.thumbUrl, width: null, height: null })
    }
  }

  return out
}

const MAX_BANNER_BYTES = 12 * 1024 * 1024

// A poster is drawn as a ~300px card, but the artwork databases serve 680x1000
// masters (a 1MB PNG is normal) — and unlike Jellyfin's proxied images, ours are
// served as-is. Downscale once at cache time so the browse grid isn't 15x
// heavier the moment an admin picks a poster. Banners keep their full width;
// they paint as a full-bleed hero. Heights come out even (`-2`) for the encoder.
const POSTER_MAX_WIDTH = 500

async function toJpeg(body: Buffer, maxWidth: number): Promise<Buffer | null> {
  try {
    const ff = spawn('ffmpeg', [
      '-v', 'error', '-i', 'pipe:0',
      '-vf', `scale='min(${maxWidth},iw)':-2:flags=lanczos`,
      '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', 'pipe:1',
    ])
    const chunks: Buffer[] = []
    ff.stdout.on('data', (c: Buffer) => chunks.push(c))
    const done = new Promise<number>((resolve, reject) => {
      ff.on('error', reject)
      ff.on('close', resolve)
    })
    ff.stdin.on('error', () => {}) // ffmpeg may close stdin early on a bad image
    ff.stdin.end(body)
    const code = await done
    const out = Buffer.concat(chunks)
    return code === 0 && out.length > 0 ? out : null
  } catch {
    return null // no ffmpeg on PATH — store the original
  }
}

/**
 * Copy a candidate's art into BANNERS_DIR so the portal never depends on the
 * source CDN. The name is derived from the URL, so re-caching the same candidate
 * rewrites the same file. Best-effort: a failure leaves `local_file` unset and
 * `serveBanner` falls back to the remote URL.
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
    let ext = EXT_BY_TYPE[type] ?? path.extname(new URL(b.url).pathname).replace('.', '').toLowerCase()
    if (!Object.values(EXT_BY_TYPE).includes(ext)) return
    let body = Buffer.from(await res.arrayBuffer())
    if (body.length === 0 || body.length > MAX_BANNER_BYTES) return

    if (b.kind === 'poster') {
      const small = await toJpeg(body, POSTER_MAX_WIDTH)
      if (small) {
        body = small
        ext = 'jpg'
      }
    }

    const digest = crypto.createHash('sha1').update(b.url).digest('hex').slice(0, 10)
    const file = `${b.mal_id}-${b.kind}-${b.source}-${digest}.${ext}`
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

/** Copy the art the portal actually serves for one kind onto the data volume. */
export async function cacheSelectedBanner(mal_id: number, kind: ArtKind = 'banner'): Promise<void> {
  const selected = getSelectedBanner(mal_id, kind)
  if (selected) await cacheBannerFile(selected)
}

/**
 * Ensure a series has its art candidates — both kinds — gathered, and its
 * selected ones cached on disk. Idempotent, additive, and best-effort: each
 * source failure is ignored, no candidate is ever removed, and the admin's
 * selection is never reassigned. Returns the banner candidates.
 */
export async function ensureSeriesBanners(mal_id: number): Promise<BannerRow[]> {
  const row = listSeries().find((s) => s.mal_id === mal_id)
  const tvdbId = row?.tvdb_id ?? null

  // `due` records the attempt, so it must be reached only when we'd really try.
  const [anilist, kitsu, providers] = await Promise.all([
    due(mal_id, 'anilist') ? fetchAniListArt(mal_id).catch(() => null) : null,
    due(mal_id, 'kitsu') ? fetchKitsuArt(mal_id).catch(() => null) : null,
    row && tvdbId != null && due(mal_id, 'providers')
      ? gatherProviderArt(row, tvdbId).catch(() => [] as Candidate[])
      : ([] as Candidate[]),
  ])
  if (anilist?.banner) addBanner({ mal_id, kind: 'banner', source: 'anilist', url: anilist.banner })
  if (anilist?.cover) addBanner({ mal_id, kind: 'poster', source: 'anilist', url: anilist.cover })
  if (kitsu?.cover) addBanner({ mal_id, kind: 'banner', source: 'kitsu', ...kitsu.cover })
  if (kitsu?.poster) addBanner({ mal_id, kind: 'poster', source: 'kitsu', ...kitsu.poster })
  for (const c of providers) addBanner({ mal_id, ...c })

  autoSelect(mal_id)
  for (const kind of ART_KINDS) await cacheSelectedBanner(mal_id, kind)
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
