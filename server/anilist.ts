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
  /** AniList status: RELEASING | FINISHED | NOT_YET_RELEASED | CANCELLED | HIATUS */
  status: string | null
  totalEpisodes: number | null
  /** Every episode with a known air timestamp (past AND future). */
  episodes: { number: number; airedAt: string }[]
  nextAiringAt: string | null
}

/**
 * Per-episode air timestamps for a MAL id, from AniList's `airingSchedule`.
 * This is the freshness-critical lookup (which episodes exist *now*), so it
 * deliberately avoids MAL/Jikan: AniList is auth-free, current, and not
 * meaningfully rate-limited at our volume. Callers cache the result in
 * `series_episodes` — never poll this per run.
 */
export async function fetchAniListAiring(malId: number): Promise<AniListAiring | null> {
  const gql = `query($idMal:Int,$page:Int){ Media(idMal:$idMal, type:ANIME){
    status episodes nextAiringEpisode{ airingAt }
    airingSchedule(page:$page, perPage:50){ pageInfo{ hasNextPage } nodes{ episode airingAt } } } }`
  const episodes: { number: number; airedAt: string }[] = []
  let status: string | null = null
  let totalEpisodes: number | null = null
  let nextAiringAt: string | null = null
  try {
    // airingSchedule is paginated; 50/page × 6 pages covers any sane series.
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
            episodes?: number | null
            nextAiringEpisode?: { airingAt?: number | null } | null
            airingSchedule?: {
              pageInfo?: { hasNextPage?: boolean }
              nodes?: Array<{ episode: number; airingAt: number }>
            }
          } | null
        }
      }
      const media = json.data?.Media
      if (!media) return null
      status = media.status ?? status
      totalEpisodes = media.episodes ?? totalEpisodes
      if (media.nextAiringEpisode?.airingAt) {
        nextAiringAt = new Date(media.nextAiringEpisode.airingAt * 1000).toISOString()
      }
      for (const n of media.airingSchedule?.nodes ?? []) {
        if (Number.isFinite(n.episode) && Number.isFinite(n.airingAt)) {
          episodes.push({ number: n.episode, airedAt: new Date(n.airingAt * 1000).toISOString() })
        }
      }
      if (!media.airingSchedule?.pageInfo?.hasNextPage) break
    }
    return { status, totalEpisodes, episodes, nextAiringAt }
  } catch {
    return null
  }
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
