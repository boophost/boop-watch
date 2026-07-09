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
}

// fanart.tv serves a downscaled copy of every asset under /preview.
function previewUrl(url: string): string | null {
  return url.includes('/fanart/') ? url.replace('/fanart/', '/preview/fanart/') : null
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

/**
 * Wide artwork for a show. Returns the show-wide backgrounds and the
 * season-tagged thumbs separately, so the caller can offer a cour its own art
 * first. Best-effort: an unset key, an unknown tvdb id (404), or any error
 * yields an empty result rather than throwing.
 */
export async function fetchFanartArt(
  tvdbId: number,
): Promise<{ backgrounds: FanartImage[]; seasonThumbs: FanartImage[] }> {
  const empty = { backgrounds: [], seasonThumbs: [] }
  if (!KEY) return empty
  try {
    const res = await limitedFetch('fanart', `${FANART_URL}/tv/${tvdbId}?api_key=${encodeURIComponent(KEY)}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return empty
    const json = (await res.json()) as FanartTvResponse
    return {
      backgrounds: toImages(json.showbackground, false),
      seasonThumbs: toImages(json.seasonthumb, true),
    }
  } catch {
    return empty
  }
}
