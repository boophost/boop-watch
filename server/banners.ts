// Season-banner candidate gathering. Wide banner art doesn't come from MAL/Jikan,
// so we pull it from several keyless sources (AniList bannerImage, Kitsu
// coverImage), store each as a candidate alongside any admin uploads, and
// auto-select a default. Admins pick among them on the series page.
//
// Candidates are *additive and durable*: every remote image is copied into
// BANNERS_DIR and served from there, so remote art that later moves or 404s
// can't change what the portal shows. Re-gathering only ever inserts new URLs —
// it never deletes a candidate or moves the admin's selection.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fetchAniListBanner } from './anilist.js'
import { addBanner, getSelectedBanner, listBanners, selectBanner, setBannerLocalFile, BannerRow } from './db.js'
import { limitedFetch } from './httpQueue.js'

/** Banner files (uploads + cached remote art) live under DATA_DIR/banners. */
export const BANNERS_DIR = path.join(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'), 'banners')

export const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif',
}

// Kitsu's wide coverImage, resolved from a MAL id via Kitsu's mappings table.
async function fetchKitsuCover(malId: number): Promise<{ url: string; width: number | null; height: number | null } | null> {
  try {
    const res = await limitedFetch(
      'kitsu',
      `https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&include=item`,
      { headers: { Accept: 'application/vnd.api+json' } },
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

const MAX_BANNER_BYTES = 12 * 1024 * 1024

/**
 * Copy a candidate's remote art into BANNERS_DIR so the portal never depends on
 * the source CDN. The name is derived from the URL, so re-caching the same
 * candidate rewrites the same file. Best-effort: a failure leaves `local_file`
 * unset and `serveBanner` falls back to the remote URL.
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
    const ext = EXT_BY_TYPE[type] ?? path.extname(new URL(b.url).pathname).replace('.', '').toLowerCase()
    if (!Object.values(EXT_BY_TYPE).includes(ext)) return
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length === 0 || body.length > MAX_BANNER_BYTES) return

    const digest = crypto.createHash('sha1').update(b.url).digest('hex').slice(0, 10)
    const file = `${b.mal_id}-${b.source}-${digest}.${ext}`
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

/**
 * Ensure a series has its banner candidates gathered and cached on disk.
 * Idempotent, additive, and best-effort: each source failure is ignored, no
 * candidate is ever removed, and the admin's selection is never reassigned.
 * Returns the current candidate list.
 */
export async function ensureSeriesBanners(mal_id: number): Promise<BannerRow[]> {
  const [anilist, kitsu] = await Promise.all([
    due(mal_id, 'anilist') ? fetchAniListBanner(mal_id).catch(() => null) : null,
    due(mal_id, 'kitsu') ? fetchKitsuCover(mal_id).catch(() => null) : null,
  ])
  if (anilist) addBanner({ mal_id, source: 'anilist', url: anilist })
  if (kitsu) addBanner({ mal_id, source: 'kitsu', url: kitsu.url, width: kitsu.width, height: kitsu.height })

  // Cache anything not yet on disk — including rows added before this existed.
  for (const row of listBanners(mal_id)) await cacheBannerFile(row)

  autoSelect(mal_id)
  return listBanners(mal_id)
}
