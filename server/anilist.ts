// AniList GraphQL client — used only for the wide banner image (`bannerImage`),
// which MAL/Jikan doesn't provide but the portal needs for a proper season hero
// (a stretched portrait poster looks bad). Public endpoint, unauthenticated,
// keyed by MAL id. Best-effort: returns null on any error/rate-limit so a hiccup
// never breaks the sync.
const ANILIST_URL = 'https://graphql.anilist.co'

export async function fetchAniListBanner(malId: number): Promise<string | null> {
  const query = 'query($idMal:Int){ Media(idMal:$idMal, type:ANIME){ bannerImage } }'
  try {
    const res = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { idMal: malId } }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { data?: { Media?: { bannerImage?: string | null } } }
    return json.data?.Media?.bannerImage ?? null
  } catch {
    return null
  }
}
