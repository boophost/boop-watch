// OP/ED theme songs, self-sourced from MAL via Jikan's /anime/{id}/themes.
// MAL stores each theme as one display string (e.g. `#1: "Song" by Artist
// (eps 1-13)`), so we parse it into title/artist/episode-range here and the
// widget renders structured rows. Keyed by mal_id — the portal resolves the
// right cour per Jellyfin season, so each season shows its own songs.
import { limitedFetch } from './httpQueue.js'

const JIKAN = process.env.JIKAN_URL || 'https://api.jikan.moe/v4'
// Themes almost never change once aired; airing shows gain one per cour at
// most, so a day-long positive TTL is plenty. Empty/failed answers may be an
// upstream blip (public Jikan 504s regularly) — retry those hourly.
const TTL = 24 * 60 * 60 * 1000
const NEG_TTL = 60 * 60 * 1000

export interface ThemeSong {
  kind: 'op' | 'ed'
  /** MAL's own numbering (`#2:`) — null for single-theme entries. */
  index: number | null
  title: string
  artist: string | null
  /** Episode range as MAL states it, e.g. "1-13" or "1-11, 13". */
  episodes: string | null
}

const cache = new Map<number, { at: number; ttl: number; themes: ThemeSong[] }>()

/**
 * Split one MAL theme string into parts. Handles the common shapes:
 *   `#1: "Title" by Artist (eps 1-13)` · `"Title" by Artist` · `"Title"`
 * Anything unparseable falls back to the whole string as the title, so a
 * format drift never hides a song.
 */
export function parseThemeString(raw: string, kind: 'op' | 'ed'): ThemeSong {
  let s = raw.trim()
  let index: number | null = null
  let episodes: string | null = null

  // Trailing `(eps …)` first — the artist part can hold its own parens (CV: …).
  const epM = /\(eps?\.?\s*([^)]*)\)\s*$/i.exec(s)
  if (epM) {
    episodes = epM[1].trim() || null
    s = s.slice(0, epM.index).trim()
  }
  // `S1:` marks a special-broadcast theme (seen on Frieren) — same shape.
  const numM = /^#?S?(\d+)\s*:\s*/.exec(s)
  if (numM) {
    index = Number(numM[1])
    s = s.slice(numM[0].length).trim()
  }

  let title = s
  let artist: string | null = null
  // Greedy title so quotes inside the song name survive; ` by ` outside the
  // closing quote is the artist separator.
  const m = /^"(.+)"\s+by\s+(.+)$/s.exec(s)
  if (m) {
    title = m[1]
    artist = m[2].trim() || null
  } else {
    const q = /^"(.+)"$/s.exec(s)
    if (q) title = q[1]
  }
  return { kind, index, title: title.trim(), artist, episodes }
}

/** Themes for one MAL entry, cached; throws only on a cold fetch failure. */
export async function themesForMal(malId: number): Promise<ThemeSong[]> {
  const hit = cache.get(malId)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.themes

  try {
    // Through the shared 'jikan' queue so this coordinates with every other
    // Jikan caller (aniskip's chain-walk, the /manage page) instead of
    // bursting past the ~3 req/s limit. Short timeout — the widget is
    // cosmetic and must not stall the title page.
    const res = await limitedFetch('jikan', `${JIKAN}/anime/${malId}/themes`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`jikan ${res.status}`)
    const json = (await res.json()) as { data?: { openings?: string[]; endings?: string[] } }
    const themes = [
      ...(json.data?.openings ?? []).map((s) => parseThemeString(s, 'op')),
      ...(json.data?.endings ?? []).map((s) => parseThemeString(s, 'ed')),
    ].filter((t) => t.title)
    cache.set(malId, { at: Date.now(), ttl: themes.length ? TTL : NEG_TTL, themes })
    return themes
  } catch (e) {
    // Serve a stale answer over an error; otherwise cache the miss briefly so
    // a flaky upstream doesn't get hammered on every page load.
    if (hit) return hit.themes
    cache.set(malId, { at: Date.now(), ttl: NEG_TTL, themes: [] })
    throw e
  }
}
