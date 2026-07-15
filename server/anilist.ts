// AniList GraphQL client — used only for the wide banner image (`bannerImage`),
// which MAL/Jikan doesn't provide but the portal needs for a proper season hero
// (a stretched portrait poster looks bad). Public endpoint, unauthenticated,
// keyed by MAL id. Best-effort: returns null on any error/rate-limit so a hiccup
// never breaks the sync. Rate-limited through the shared 'anilist' queue.
import { limitedFetch } from './httpQueue.js'

const ANILIST_URL = 'https://graphql.anilist.co'

/** A search hit shaped like the /api/search/anime response (mirrors the Jikan mapping). */
export interface AniListSearchHit {
  mal_id: number
  title: string
  synopsis: string
  image_url: string | null
  url: string
}

const stripHtml = (s: string): string =>
  s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

/**
 * Search anime via AniList — the fallback for when Jikan (an unofficial MAL
 * proxy) can't reach MyAnimeList. AniList carries `idMal`, so hits map to a real
 * `mal_id` and stay addable to our MAL-id catalog. Entries without an idMal are
 * dropped (we can't add those). Best-effort: throws only on a hard request error.
 */
export async function searchAnimeAniList(
  query: string,
  limit = 15,
): Promise<AniListSearchHit[]> {
  const q = query.trim()
  if (!q) return []
  const gql = `query($q:String,$n:Int){ Page(perPage:$n){ media(search:$q, type:ANIME, sort:SEARCH_MATCH){
    idMal title{ romaji english } description(asHtml:false) coverImage{ large medium } } } }`
  const res = await limitedFetch('anilist', ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: gql, variables: { q, n: limit } }),
  })
  if (!res.ok) throw new Error(`AniList returned ${res.status}`)
  const json = (await res.json()) as {
    data?: {
      Page?: {
        media?: Array<{
          idMal: number | null
          title: { romaji: string | null; english: string | null }
          description: string | null
          coverImage: { large: string | null; medium: string | null }
        }>
      }
    }
  }
  const seen = new Set<number>()
  const out: AniListSearchHit[] = []
  for (const m of json.data?.Page?.media ?? []) {
    if (m.idMal == null || seen.has(m.idMal)) continue
    seen.add(m.idMal)
    out.push({
      mal_id: m.idMal,
      title: m.title.english || m.title.romaji || `MAL #${m.idMal}`,
      synopsis: m.description ? stripHtml(m.description) : '',
      image_url: m.coverImage.large || m.coverImage.medium || null,
      url: `https://myanimelist.net/anime/${m.idMal}`,
    })
  }
  return out
}

export interface AniListAiring {
  /** MAL-style airing status string (mapped from the AniList enum). */
  status: string | null
  totalEpisodes: number | null
  /** Every episode with a known air timestamp (past AND future). */
  episodes: { number: number; airedAt: string }[]
  nextAiringAt: string | null
}

/**
 * Everything a catalog + episode refresh needs from AniList in one shape. This
 * is the primary metadata source (AniList is current and auth-free; MAL/Jikan
 * lags on which episodes exist). `status`/`type`/`season` are already mapped to
 * the MAL-style strings the catalog UI expects; `episodes` is the freshness-
 * critical airing schedule; `streamingTitles` is AniList's only per-episode
 * title source (partial/messy — a fallback title contributor, never authority).
 */
export interface AniListMedia extends AniListAiring {
  title: string
  titleEnglish: string | null
  titleRomaji: string | null
  titleNative: string | null
  synopsis: string | null
  coverImage: string | null
  bannerImage: string | null
  /** MAL-style media type: TV | Movie | OVA | ONA | Special | Music. */
  type: string | null
  /** MAL-style airing status string (see mapAniListStatus). */
  score: number | null
  year: number | null
  /** winter | spring | summer | fall (lowercased, matches MAL). */
  season: string | null
  airedString: string | null
  studios: string[]
  genres: string[]
  broadcast: { day: string | null; time: string | null; timezone: string | null; string: string | null } | null
  /** Best-effort per-episode titles from streamingEpisodes, number-parsed. */
  streamingTitles: { number: number; title: string }[]
}

/** AniList enum → the "Currently Airing"/"Finished Airing"/… strings the catalog UI shows. */
export function mapAniListStatus(status: string | null | undefined): string | null {
  switch (status) {
    case 'RELEASING': return 'Currently Airing'
    case 'FINISHED': return 'Finished Airing'
    case 'NOT_YET_RELEASED': return 'Not yet aired'
    case 'CANCELLED': return 'Cancelled'
    case 'HIATUS': return 'On Hiatus'
    default: return null
  }
}

/** AniList format enum → MAL-style media type string. */
function mapAniListFormat(format: string | null | undefined): string | null {
  switch (format) {
    case 'TV': case 'TV_SHORT': return 'TV'
    case 'MOVIE': return 'Movie'
    case 'OVA': return 'OVA'
    case 'ONA': return 'ONA'
    case 'SPECIAL': return 'Special'
    case 'MUSIC': return 'Music'
    default: return null
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
type FuzzyDate = { year?: number | null; month?: number | null; day?: number | null } | null | undefined
function fmtDate(d: FuzzyDate): string | null {
  if (!d?.year) return null
  const m = d.month && d.month >= 1 && d.month <= 12 ? MONTHS[d.month - 1] + ' ' : ''
  const day = d.day ? `${d.day}, ` : ''
  return `${m}${day}${d.year}`
}
/** MAL-style "Jul 6, 2026 to ?" aired string from AniList start/end fuzzy dates. */
function fmtAired(start: FuzzyDate, end: FuzzyDate): string | null {
  const s = fmtDate(start)
  if (!s) return null
  const e = fmtDate(end)
  return `${s} to ${e ?? '?'}`
}

/** Best-effort broadcast from the next-airing timestamp (AniList has no broadcast field). */
function deriveBroadcast(nextAiringAt: string | null): AniListMedia['broadcast'] {
  if (!nextAiringAt) return null
  const d = new Date(nextAiringAt)
  if (Number.isNaN(d.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const day = parts.find((p) => p.type === 'weekday')?.value ?? null
  const hh = parts.find((p) => p.type === 'hour')?.value ?? null
  const mm = parts.find((p) => p.type === 'minute')?.value ?? null
  const time = hh != null && mm != null ? `${hh === '24' ? '00' : hh}:${mm}` : null
  return {
    day: day ? `${day}s` : null,
    time,
    timezone: 'Asia/Tokyo',
    string: day && time ? `${day}s at ${time} (JST)` : null,
  }
}

/** Parse "Episode 3 - The Title" / "EP3: Title" → { number, title }; null if no number. */
function parseStreamingTitle(raw: string, index: number): { number: number; title: string } | null {
  const t = raw.trim()
  if (!t) return null
  const m = /^(?:episode|ep\.?|e)\s*(\d+)\s*[-:.–]?\s*(.*)$/i.exec(t)
  const number = m ? Number(m[1]) : index + 1
  const title = (m ? m[2] : t).trim()
  if (!Number.isFinite(number)) return null
  return { number, title: title || t }
}

/**
 * Full AniList metadata + airing schedule + streaming titles for a MAL id, in
 * one paginated fetch. Best-effort: null on any error. Callers persist the
 * catalog fields (enrich.metadata) and cache episodes/titles in `series_episodes`.
 */
export async function fetchAniListMedia(malId: number): Promise<AniListMedia | null> {
  const gql = `query($idMal:Int,$page:Int){ Media(idMal:$idMal, type:ANIME){
    status format episodes averageScore seasonYear season
    title{ romaji english native } description(asHtml:false)
    coverImage{ extraLarge large } bannerImage genres
    studios{ edges{ isMain node{ name } } }
    startDate{ year month day } endDate{ year month day }
    nextAiringEpisode{ airingAt } streamingEpisodes{ title }
    airingSchedule(page:$page, perPage:50){ pageInfo{ hasNextPage } nodes{ episode airingAt } } } }`
  const episodes: { number: number; airedAt: string }[] = []
  let head: AniListMedia | null = null
  try {
    // airingSchedule is paginated; 50/page × 6 pages covers any sane series. The
    // heavy head fields come back on every page — capture them once (page 1).
    for (let page = 1; page <= 6; page++) {
      const res = await limitedFetch('anilist', ANILIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: gql, variables: { idMal: malId, page } }),
      })
      if (!res.ok) return null
      const json = (await res.json()) as {
        data?: {
          Media?: {
            status?: string | null
            format?: string | null
            episodes?: number | null
            averageScore?: number | null
            seasonYear?: number | null
            season?: string | null
            title?: { romaji?: string | null; english?: string | null; native?: string | null }
            description?: string | null
            coverImage?: { extraLarge?: string | null; large?: string | null }
            bannerImage?: string | null
            genres?: string[]
            studios?: { edges?: Array<{ isMain?: boolean; node?: { name?: string | null } }> }
            startDate?: FuzzyDate
            endDate?: FuzzyDate
            nextAiringEpisode?: { airingAt?: number | null } | null
            streamingEpisodes?: Array<{ title?: string | null }>
            airingSchedule?: {
              pageInfo?: { hasNextPage?: boolean }
              nodes?: Array<{ episode: number; airingAt: number }>
            }
          } | null
        }
      }
      const media = json.data?.Media
      if (!media) return null
      if (head == null) {
        const nextAiringAt = media.nextAiringEpisode?.airingAt
          ? new Date(media.nextAiringEpisode.airingAt * 1000).toISOString()
          : null
        const edges = media.studios?.edges ?? []
        const mainStudios = edges.filter((e) => e.isMain).map((e) => e.node?.name).filter((n): n is string => !!n)
        const allStudios = edges.map((e) => e.node?.name).filter((n): n is string => !!n)
        const streamingTitles: { number: number; title: string }[] = []
        ;(media.streamingEpisodes ?? []).forEach((s, i) => {
          const p = s.title ? parseStreamingTitle(s.title, i) : null
          if (p) streamingTitles.push(p)
        })
        head = {
          status: mapAniListStatus(media.status),
          totalEpisodes: media.episodes ?? null,
          episodes,
          nextAiringAt,
          title: media.title?.english || media.title?.romaji || `MAL #${malId}`,
          titleEnglish: media.title?.english ?? null,
          titleRomaji: media.title?.romaji ?? null,
          titleNative: media.title?.native ?? null,
          synopsis: media.description ? stripHtml(media.description) : null,
          coverImage: media.coverImage?.extraLarge || media.coverImage?.large || null,
          bannerImage: media.bannerImage ?? null,
          type: mapAniListFormat(media.format),
          score: media.averageScore != null ? Math.round((media.averageScore / 10) * 100) / 100 : null,
          year: media.seasonYear ?? media.startDate?.year ?? null,
          season: media.season ? media.season.toLowerCase() : null,
          airedString: fmtAired(media.startDate, media.endDate),
          studios: mainStudios.length > 0 ? mainStudios : allStudios,
          genres: media.genres ?? [],
          broadcast: deriveBroadcast(nextAiringAt),
          streamingTitles,
        }
      }
      for (const n of media.airingSchedule?.nodes ?? []) {
        if (Number.isFinite(n.episode) && Number.isFinite(n.airingAt)) {
          episodes.push({ number: n.episode, airedAt: new Date(n.airingAt * 1000).toISOString() })
        }
      }
      if (!media.airingSchedule?.pageInfo?.hasNextPage) break
    }
    return head
  } catch {
    return null
  }
}

/**
 * Per-episode air timestamps for a MAL id. Thin wrapper over `fetchAniListMedia`
 * so there's a single AniList fetch path. This is the freshness-critical lookup
 * (which episodes exist *now*); callers cache the result in `series_episodes`.
 */
export async function fetchAniListAiring(malId: number): Promise<AniListAiring | null> {
  const m = await fetchAniListMedia(malId)
  if (!m) return null
  return { status: m.status, totalEpisodes: m.totalEpisodes, episodes: m.episodes, nextAiringAt: m.nextAiringAt }
}

/** AniList's wide `bannerImage` and portrait `coverImage`, in one request. */
export async function fetchAniListArt(
  malId: number,
): Promise<{ banner: string | null; cover: string | null }> {
  const query =
    'query($idMal:Int){ Media(idMal:$idMal, type:ANIME){ bannerImage coverImage{ extraLarge large } } }'
  try {
    const res = await limitedFetch('anilist', ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { idMal: malId } }),
    })
    if (!res.ok) return { banner: null, cover: null }
    const json = (await res.json()) as {
      data?: { Media?: { bannerImage?: string | null; coverImage?: { extraLarge?: string | null; large?: string | null } } }
    }
    const media = json.data?.Media
    return {
      banner: media?.bannerImage ?? null,
      cover: media?.coverImage?.extraLarge || media?.coverImage?.large || null,
    }
  } catch {
    return { banner: null, cover: null }
  }
}
