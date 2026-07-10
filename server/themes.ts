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
  /** Album/single cover from iTunes Search — null until a lookup lands. */
  art: string | null
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
  return { kind, index, title: title.trim(), artist, episodes, art: null }
}

// ── Album art (iTunes Search — free, keyless) ──────────────────────────────
// MAL writes titles as `Romaji (日本語)` and artists as `Romaji (日本語)`; iTunes
// matches the *Japanese* title far better ("晴る Yorushika" → the real song,
// "Haru (晴る) Yorushika" → an unrelated track), so try the parenthetical CJK
// title first, then the romaji. Results are validated against the artist name
// to reject karaoke/cover uploads.
const ITUNES = 'https://itunes.apple.com/search'
const ART_TTL = 7 * 24 * 60 * 60 * 1000
const ART_NEG_TTL = 24 * 60 * 60 * 1000
const artCache = new Map<string, { at: number; url: string | null }>()

const normLoose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** `Romaji (日本語)` → `{ main: 'Romaji', paren: '日本語' | null }`. */
function splitParen(s: string): { main: string; paren: string | null } {
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(s.trim())
  if (m && m[1]) return { main: m[1].trim(), paren: m[2].trim() }
  return { main: s.trim(), paren: null }
}

interface ItunesTrack { artistName?: string; artworkUrl100?: string }

async function itunesSearch(term: string): Promise<ItunesTrack[]> {
  const u = new URL(ITUNES)
  u.searchParams.set('term', term)
  u.searchParams.set('media', 'music')
  u.searchParams.set('entity', 'song')
  u.searchParams.set('limit', '5')
  const res = await limitedFetch('itunes', u, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`itunes ${res.status}`)
  const json = (await res.json()) as { results?: ItunesTrack[] }
  return json.results ?? []
}

/**
 * Cover-art URL for a song, cached. The queue paces iTunes well under its
 * ~20 req/min budget, so a cold multi-song title fills in over a few loads —
 * callers should budget-race this, not block on it.
 */
export async function artForSong(title: string, artist: string | null): Promise<string | null> {
  const key = `${normLoose(title)}|${normLoose(artist ?? '')}`
  const hit = artCache.get(key)
  if (hit && Date.now() - hit.at < (hit.url ? ART_TTL : ART_NEG_TTL)) return hit.url

  const t = splitParen(title)
  const a = splitParen(artist ?? '')
  const artistNorms = [a.main, a.paren].filter(Boolean).map((s) => normLoose(s as string))
  const terms = [...new Set(
    [t.paren, t.main]
      .filter((x): x is string => !!x)
      .map((x) => `${x} ${a.main}`.trim()),
  )]

  let url: string | null = null
  for (const term of terms) {
    let results: ItunesTrack[]
    try {
      results = await itunesSearch(term)
    } catch {
      // Upstream hiccup — don't negative-cache a blip, just answer nothing now.
      if (hit) return hit.url
      return null
    }
    const match = results.find((r) => {
      if (!r.artworkUrl100) return false
      if (artistNorms.length === 0) return true
      const got = normLoose(r.artistName ?? '')
      return artistNorms.some((want) => got.includes(want) || want.includes(got))
    })
    if (match?.artworkUrl100) {
      url = match.artworkUrl100.replace('100x100', '200x200')
      break
    }
  }
  artCache.set(key, { at: Date.now(), url })
  return url
}

/**
 * Fill `art` on each song, waiting at most `budgetMs` — lookups that miss the
 * budget keep running and land in the cache for the next request. Returns new
 * objects; the themes cache entries are shared and must stay unmutated.
 */
export async function withArt(themes: ThemeSong[], budgetMs: number): Promise<ThemeSong[]> {
  const out = themes.map((t) => ({ ...t }))
  await Promise.race([
    Promise.all(out.map(async (t) => {
      t.art = await artForSong(t.title, t.artist).catch(() => null)
    })),
    new Promise<void>((r) => setTimeout(r, budgetMs)),
  ])
  return out
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
