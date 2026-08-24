// Library folder-name identity: deciding when two directory names mean the same
// show, and finding the directories a series actually occupies.
//
// Extracted from flowNodes.ts so the *importer* and the *manage UI* answer this
// question with the same code. They disagreed once, expensively: the import
// wrote "ReZERO -Starting Life in Another World (2026)" beside Sonarr's
// "Re - ZERO, Starting Life in Another World", Jellyfin indexed the twin as a
// second series outside the Public collection, and the affected episodes sat at
// "importing" indefinitely with no surface anywhere that said why. The page can
// now report the split (see seriesLibraryDirs) precisely because it shares this
// definition with the code that creates it.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/**
 * Two imports of the same show can render different folder names: `{show}
 * ({production_year})` carries the *cour's* year onto a *franchise* folder, so
 * Slime S1 wants "… Slime (2018)" and S4 wants "… Slime (2026)" — and when the
 * metadata hasn't resolved, `sanitizeSegments` drops the empty "()" and yields a
 * third variant. `Season {season:2}` likewise renders "Season 04" where an older
 * import wrote "Season 4". Normalising those away lets us reuse the directory
 * that already holds the show instead of splitting it in two.
 */
export function normalizeDirName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\s*\((?:19|20)\d{2}\)\s*$/, '')
      // Punctuation is the other way these names drift, and it is the way that
      // actually bit us. Our template renders a MAL title ("ReZERO -Starting
      // Life in Another World"); the folder already on disk came from Sonarr via
      // TVDB ("Re - ZERO, Starting Life in Another World"). Same show, same
      // words, different dashes and commas — so the year/padding rules above
      // both matched and the twin got created anyway. Fold punctuation to
      // spaces, then drop spaces entirely, because the disagreement is often
      // *inside* a word ("ReZERO" vs "Re - ZERO").
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/^season\s*0*(\d+)$/, 'season $1')
      .replace(/\s+/g, '')
  )
}

/** The directory to use for one templated segment: an existing directory that
 * differs only by a `(year)` suffix, season padding or punctuation, else
 * `wanted` itself.
 *
 * Note we deliberately do NOT short-circuit on `existsSync(wanted)`: once a
 * `… (2026)` twin exists alongside the legacy `…` folder, returning the exact
 * templated name would keep every import landing in the twin, and Jellyfin
 * indexes it as a second, separate (and non-Public) series — the episodes never
 * surface on the portal, so the chase sits at "importing" forever. Always run
 * the normalised match and pick the canonical twin so both folders converge. */
export async function resolveDirSegment(parent: string, wanted: string): Promise<string> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(parent, { withFileTypes: true })
  } catch {
    return wanted
  }
  const target = normalizeDirName(wanted)
  const matches = entries
    .filter((e) => e.isDirectory() && normalizeDirName(e.name) === target)
    .map((e) => e.name)
    .sort()
  if (matches.length <= 1) return matches[0] ?? wanted
  // A duplicate pair already exists, so a previous import split this show. Pick
  // the directory that actually holds the library rather than trusting name
  // order: the twin we minted has one season in it, the real folder has every
  // season. Choosing by name here is what would keep every future import
  // landing in the twin, leaving Jellyfin with two series and the chase stuck
  // at "importing". Ties break by name so the result stays deterministic.
  const weighed = await Promise.all(
    matches.map(async (name) => {
      let count = 0
      try {
        count = (await fsp.readdir(path.join(parent, name))).length
      } catch {
        count = 0
      }
      return { name, count }
    }),
  )
  weighed.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return weighed[0].name
}

/** Re-point a templated relative path at the directories already on disk. */
export async function resolveExistingPath(root: string, rel: string): Promise<string> {
  const parts = rel.split('/')
  const file = parts.pop() as string
  let dir = root
  const resolved: string[] = []
  // Sequential by necessity: each segment is resolved inside the directory the
  // previous one picked.
  for (const seg of parts) {
    const use = await resolveDirSegment(dir, seg)
    resolved.push(use)
    dir = path.join(dir, use)
  }
  return [...resolved, file].join('/')
}

/**
 * Every directory under `root` that reads as this series' folder.
 *
 * More than one means the library is split — the state that made today's
 * incident invisible. Returned rather than auto-merged: consolidating folders
 * moves real files around and is the operator's call, not a page render's.
 *
 * `titles` should carry every name the show is known by (catalog title, English
 * title, the franchise name the import template would render), because the
 * whole point is that the two folders were named from *different* sources.
 */
export async function seriesLibraryDirs(root: string, titles: (string | null | undefined)[]): Promise<string[]> {
  const targets = new Set(
    titles
      .map((t) => normalizeDirName(String(t ?? '')))
      .filter((t) => t.length >= 3), // a 1-2 char normalised name matches far too much
  )
  if (targets.size === 0) return []
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && targets.has(normalizeDirName(e.name)))
    .map((e) => e.name)
    .sort()
}
