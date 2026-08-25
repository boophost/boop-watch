import { getPortalItem } from './portalDb.js'
import { getPlayableIds, isCollectionItem } from './jellyfin.js'

export const SITE_NAME = 'boopurnoes · watch'
export const SITE_DESCRIPTION = 'A curated streaming library.'

export interface SharePage {
  title: string
  description: string
  path: string
  imagePath: string
  imageAlt: string
}

const DESC_MAX = 200

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function clip(s: string, n = DESC_MAX): string {
  const t = collapse(s)
  if (t.length <= n) return t
  const cut = t.slice(0, n - 1)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > 80 ? cut.slice(0, sp) : cut).trimEnd()}…`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function tag(attr: 'name' | 'property', key: string, value: string): string {
  return `    <meta ${attr}="${key}" content="${escapeHtml(value)}" />`
}

function yearOf(item: { production_year: number | null; premiere_date: string | null }): number | null {
  if (item.production_year != null) return item.production_year
  if (!item.premiere_date) return null
  const y = new Date(item.premiere_date).getFullYear()
  return Number.isFinite(y) ? y : null
}

function titleWithYear(name: string, year: number | null): string {
  return year != null ? `${name} (${year})` : name
}

function sitePage(path: string, title = SITE_NAME, description = SITE_DESCRIPTION): SharePage {
  return {
    title,
    description,
    path,
    imagePath: '/og.png',
    imageAlt: SITE_NAME,
  }
}

function fromPortalId(path: string, id: string, kind: 'title' | 'watch'): SharePage {
  const item = getPortalItem(id)
  if (!item) return sitePage(path)

  const inScope =
    kind === 'watch'
      ? getPlayableIds().has(id) || isCollectionItem(id)
      : isCollectionItem(id)
  if (!inScope) return sitePage(path)

  const isEpisode = item.type === 'Episode'
  const artId = (isEpisode && item.series_id) ? item.series_id : item.id
  const imagePath = `/img/${encodeURIComponent(artId)}/backdrop`

  if (kind === 'watch' && isEpisode) {
    const show = item.series_name || item.name
    const se =
      item.index_number != null
        ? `S${String(item.parent_index_number ?? 1).padStart(2, '0')}E${String(item.index_number).padStart(2, '0')}`
        : null
    const title = [show, se].filter(Boolean).join(' ')
    const description = clip(item.overview || item.name || SITE_DESCRIPTION)
    return { title, description, path, imagePath, imageAlt: title }
  }

  const title = titleWithYear(item.name, yearOf(item))
  const description = clip(item.overview || SITE_DESCRIPTION)
  return { title, description, path, imagePath, imageAlt: title }
}

/** Per-path share card. Unknown / private / admin routes get the site default. */
export function sharePageForPath(pathname: string): SharePage {
  const path = pathname.split('?')[0] || '/'
  if (path === '/tv') return sitePage(path, `TV · ${SITE_NAME}`, 'A curated TV library.')
  if (path === '/movies') return sitePage(path, `Movies · ${SITE_NAME}`, 'A curated movie library.')
  if (path === '/schedule') return sitePage(path, `Schedule · ${SITE_NAME}`, "This week's anime airings.")
  if (path === '/') return sitePage(path, SITE_NAME, 'A curated anime library.')

  const series = path.match(/^\/series\/([^/]+)\/?$/)
  if (series) return fromPortalId(path, decodeURIComponent(series[1]), 'title')
  const movie = path.match(/^\/movie\/([^/]+)\/?$/)
  if (movie) return fromPortalId(path, decodeURIComponent(movie[1]), 'title')
  const watch = path.match(/^\/watch\/([^/]+)\/?$/)
  if (watch) return fromPortalId(path, decodeURIComponent(watch[1]), 'watch')

  return sitePage(path)
}

export function renderShareMeta(page: SharePage, origin: string): string {
  const url = origin + (page.path === '/' ? '/' : page.path)
  const image = origin + page.imagePath
  const title = page.title
  const description = page.description
  return [
    `    <title>${escapeHtml(title)}</title>`,
    tag('name', 'description', description),
    tag('name', 'robots', 'noindex, nofollow'),
    `    <link rel="canonical" href="${escapeHtml(url)}" />`,
    tag('property', 'og:site_name', SITE_NAME),
    tag('property', 'og:locale', 'en_US'),
    tag('property', 'og:type', 'website'),
    tag('property', 'og:title', title),
    tag('property', 'og:description', description),
    tag('property', 'og:url', url),
    tag('property', 'og:image', image),
    tag('property', 'og:image:alt', page.imageAlt),
    tag('name', 'twitter:card', 'summary_large_image'),
    tag('name', 'twitter:title', title),
    tag('name', 'twitter:description', description),
    tag('name', 'twitter:image', image),
    tag('name', 'twitter:image:alt', page.imageAlt),
  ].join('\n')
}

const BLOCK_RE = /<!--share-meta-->[\s\S]*?<!--\/share-meta-->/

export function injectShareMeta(html: string, page: SharePage, origin: string): string {
  const block = `<!--share-meta-->\n${renderShareMeta(page, origin)}\n    <!--/share-meta-->`
  if (BLOCK_RE.test(html)) return html.replace(BLOCK_RE, block)
  return html.replace(/<\/head>/i, `    ${block}\n  </head>`)
}
