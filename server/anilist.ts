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
