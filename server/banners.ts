// Season-banner candidate gathering. Wide banner art doesn't come from MAL/Jikan,
// so we pull it from several keyless sources (AniList bannerImage, Kitsu
// coverImage), store each as a candidate alongside any admin uploads, and
// auto-select a default. Admins pick among them on the series page.
import { fetchAniListBanner } from './anilist.js'
import { addBanner, getSelectedBanner, listBanners, selectBanner, BannerRow } from './db.js'

// Kitsu's wide coverImage, resolved from a MAL id via Kitsu's mappings table.
async function fetchKitsuCover(malId: number): Promise<{ url: string; width: number | null; height: number | null } | null> {
  try {
    const res = await fetch(
      `https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&include=item`,
      { headers: { Accept: 'application/vnd.api+json' }, signal: AbortSignal.timeout(15_000) },
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

// Pick the default when nothing is selected yet: prefer AniList, then Kitsu,
// then whatever's first (e.g. an upload).
function autoSelect(mal_id: number): void {
  if (getSelectedBanner(mal_id)) return
  const rows = listBanners(mal_id)
  if (rows.length === 0) return
  const order = ['anilist', 'kitsu', 'upload']
  const pick =
    rows.slice().sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source))[0] ?? rows[0]
  selectBanner(mal_id, pick.id)
}

// Series whose remote sources we've already queried this process — so a title
// with no banner on any source isn't re-fetched every 5-minute sync.
const remoteTried = new Set<number>()

// Persisted evidence we fetched remotes before (survives a restart for the
// common case where at least one source had art).
function hasRemoteRows(mal_id: number): boolean {
  return listBanners(mal_id).some((b) => b.source === 'anilist' || b.source === 'kitsu')
}

/**
 * Ensure a series has its banner candidates gathered from the remote sources.
 * Idempotent and best-effort: remote sources are queried at most once, and each
 * source failure is ignored. Returns the current candidate list.
 */
export async function ensureSeriesBanners(mal_id: number): Promise<BannerRow[]> {
  if (!remoteTried.has(mal_id) && !hasRemoteRows(mal_id)) {
    remoteTried.add(mal_id)
    const [anilist, kitsu] = await Promise.all([fetchAniListBanner(mal_id), fetchKitsuCover(mal_id)])
    if (anilist) addBanner({ mal_id, source: 'anilist', url: anilist })
    if (kitsu) addBanner({ mal_id, source: 'kitsu', url: kitsu.url, width: kitsu.width, height: kitsu.height })
  }

  autoSelect(mal_id)
  return listBanners(mal_id)
}
