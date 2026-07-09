// fanart.tv client — a second artwork catalog for season banners, keyed by the
// tvdb id our season mapping already resolves. Its `showbackground` set is
// human-curated 16:9 art, and `seasonthumb` is genuinely per-season.
//
// Needs a free personal API key (FANART_API_KEY). Unset ⇒ every lookup is a
// no-op, exactly like JIMAKU_API_KEY: the other banner sources still work.
import { limitedFetch } from './httpQueue.js'

const FANART_URL = (process.env.FANART_URL || 'https://webservice.fanart.tv/v3').replace(/\/+$/, '')
const KEY = process.env.FANART_API_KEY

export const fanartConfigured = Boolean(KEY)

export interface FanartImage {
  url: string
  thumbUrl: string | null
  /** null on `showbackground` (whole-show art); set on `seasonthumb`. */
  season: number | null
}

interface FanartArt {
  url?: string
  season?: string
}

interface FanartTvResponse {
  showbackground?: FanartArt[]
  seasonthumb?: FanartArt[]
  tvposter?: FanartArt[]
  seasonposter?: FanartArt[]
}

// fanart.tv mirrors every asset as a ~10KB thumbnail: assets.fanart.tv/fanart/x.jpg
// is served at assets.fanart.tv/preview/x.jpg. (It ignores resize query params.)
function previewUrl(url: string): string | null {
  return url.includes('/fanart/') ? url.replace('/fanart/', '/preview/') : null
}

function toImages(art: FanartArt[] | undefined, seasonScoped: boolean): FanartImage[] {
  const out: FanartImage[] = []
  for (const a of art ?? []) {
    if (!a.url) continue
    // Season art is tagged "all" for show-wide entries; those aren't per-season.
    const season = seasonScoped ? Number(a.season) : NaN
    if (seasonScoped && !Number.isFinite(season)) continue
    out.push({ url: a.url, thumbUrl: previewUrl(a.url), season: seasonScoped ? season : null })
  }
  return out
}

export interface FanartArtSets {
  /** Wide art: show-wide backgrounds, and season-tagged thumbs. */
  backgrounds: FanartImage[]
  seasonThumbs: FanartImage[]
  /** Portrait art: show-wide posters, and season-tagged posters. */
  posters: FanartImage[]
  seasonPosters: FanartImage[]
}

const EMPTY: FanartArtSets = { backgrounds: [], seasonThumbs: [], posters: [], seasonPosters: [] }

/**
 * Every artwork set we use for a show, in one request. Show-wide and
 * season-tagged art are kept apart so the caller can offer a cour its own art
 * first. Best-effort: an unset key, an unknown tvdb id (404), or any error
 * yields empty sets rather than throwing.
 */
export async function fetchFanartArt(tvdbId: number): Promise<FanartArtSets> {
  if (!KEY) return EMPTY
  try {
    const res = await limitedFetch('fanart', `${FANART_URL}/tv/${tvdbId}?api_key=${encodeURIComponent(KEY)}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return EMPTY
    const json = (await res.json()) as FanartTvResponse
    return {
      backgrounds: toImages(json.showbackground, false),
      seasonThumbs: toImages(json.seasonthumb, true),
      posters: toImages(json.tvposter, false),
      seasonPosters: toImages(json.seasonposter, true),
    }
  } catch {
    return EMPTY
  }
}
