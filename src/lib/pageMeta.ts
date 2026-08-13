export const SITE_NAME = 'boopurnoes · watch'

export function setPageTitle(page?: string): void {
  document.title = page ? `${page} · ${SITE_NAME}` : SITE_NAME
}
