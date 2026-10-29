// Storage overview + cleanup for /manage/storage.
//
// Exists because the media disk filled (Oct 2026) and nothing that could see it
// could also free it: Jellyfin's media mount is read-only, qBittorrent can only
// delete its own downloads, and the library copies are *hardlinks* to those
// downloads — so deleting either side alone frees almost nothing. This pod
// mounts both (same NFS export, same paths qBit reports), which makes it the one
// place that can show what a deletion actually frees and do both halves at once.
//
// The folder ↔ torrent link is by inode, not by name: a hardlinked library file
// *is* the torrent's file, whatever either is called, and that is exactly the
// fact that decides whether space comes back.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PORTAL_SECTIONS, type PortalSection } from './portalDb.js'
import { sectionLibraryRoot } from './sections.js'
import { listSeries, listLibraryFiles, forgetLibraryDir, type SeriesRow } from './db.js'
import { normalizeDirName } from './libraryPaths.js'
import { qbitConfigured, qbitList, qbitDelete, parseTorrentTags, type QbitTorrent } from './qbit.js'
import { jellyfinConfigured, jfUrl, jfHeaders } from './jellyfin.js'

export interface StorageVolume {
  /** The paths (library roots, download dirs) that live on this filesystem. */
  paths: string[]
  totalBytes: number
  freeBytes: number
}

export interface CatalogRef {
  id: number
  title: string
}

export interface StorageFolder {
  section: PortalSection
  name: string
  bytes: number
  files: number
  /** Bytes in files that are hardlinked to a torrent's files. Deleting the
   * folder without those torrents frees `bytes - linkedBytes`. */
  linkedBytes: number
  torrents: string[]
  catalog: CatalogRef | null
}

export interface StorageTorrent {
  hash: string
  name: string
  category: string
  state: string
  progress: number
  bytes: number
  linkedBytes: number
  /** `section/name` keys of the library folders sharing files with it. */
  folders: string[]
  catalog: CatalogRef | null
  addedOn: number
}

export interface StorageReport {
  volumes: StorageVolume[]
  folders: StorageFolder[]
  torrents: StorageTorrent[]
  qbitError: string | null
  /** Library roots that could not be read (unset, or not mounted here). */
  missingRoots: { section: PortalSection; root: string }[]
}

export const folderKey = (section: string, name: string): string => `${section}/${name}`

interface FileStat {
  key: string // dev:ino
  size: number
}

// Every regular file under `p` (or `p` itself), lstat'd so a symlink is never
// followed out of the tree.
async function walk(p: string, out: FileStat[]): Promise<void> {
  let st: fs.Stats
  try {
    st = await fsp.lstat(p)
  } catch {
    return
  }
  if (st.isFile()) {
    out.push({ key: `${st.dev}:${st.ino}`, size: st.size })
    return
  }
  if (!st.isDirectory()) return
  let names: string[]
  try {
    names = await fsp.readdir(p)
  } catch {
    return
  }
  await Promise.all(names.map((n) => walk(path.join(p, n), out)))
}

function catalogMatcher(section: PortalSection, rows: SeriesRow[]) {
  const byName = new Map<string, SeriesRow>()
  for (const s of rows) {
    if (s.section !== section) continue
    for (const t of [s.title, s.title_english]) if (t) byName.set(normalizeDirName(t), s)
  }
  // The ledger is ground truth for folders we imported into: it names the
  // series even when the folder name has drifted from the catalog title.
  const byLedger = new Map<string, SeriesRow>()
  const byId = new Map(rows.map((s) => [s.id, s]))
  for (const f of listLibraryFiles()) {
    const s = f.series_id != null ? byId.get(f.series_id) : undefined
    const top = f.path.replace(/\\/g, '/').split('/')[0]
    if (s && s.section === section && top) byLedger.set(top, s)
  }
  return (name: string): CatalogRef | null => {
    const s = byLedger.get(name) ?? byName.get(normalizeDirName(name))
    return s ? { id: s.id, title: s.title } : null
  }
}

async function volumeOf(p: string): Promise<{ dev: number; total: number; free: number } | null> {
  try {
    const [st, fsInfo] = await Promise.all([fsp.stat(p), fsp.statfs(p)])
    return { dev: st.dev, total: fsInfo.blocks * fsInfo.bsize, free: fsInfo.bavail * fsInfo.bsize }
  } catch {
    return null
  }
}

export async function buildStorageReport(): Promise<StorageReport> {
  const series = listSeries()
  const missingRoots: StorageReport['missingRoots'] = []
  const folders: StorageFolder[] = []
  // inode → folder keys that hold it
  const inodeFolders = new Map<string, Set<string>>()
  const folderFiles = new Map<string, FileStat[]>()

  const roots = new Map<PortalSection, string>()
  for (const section of PORTAL_SECTIONS) {
    const root = sectionLibraryRoot(section)
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      missingRoots.push({ section, root })
      continue
    }
    roots.set(section, root)
    const match = catalogMatcher(section, series)
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const files: FileStat[] = []
      await walk(path.join(root, e.name), files)
      const key = folderKey(section, e.name)
      folderFiles.set(key, files)
      for (const f of files) {
        let set = inodeFolders.get(f.key)
        if (!set) inodeFolders.set(f.key, (set = new Set()))
        set.add(key)
      }
      folders.push({
        section,
        name: e.name,
        bytes: files.reduce((n, f) => n + f.size, 0),
        files: files.length,
        linkedBytes: 0,
        torrents: [],
        catalog: match(e.name),
      })
    }
  }

  let raw: QbitTorrent[] = []
  let qbitError: string | null = null
  if (qbitConfigured()) {
    try {
      raw = await qbitList()
    } catch (e) {
      qbitError = e instanceof Error ? e.message : String(e)
    }
  } else {
    qbitError = 'qBittorrent is not configured'
  }

  const folderByKey = new Map(folders.map((f) => [folderKey(f.section, f.name), f]))
  const torrentInodes = new Set<string>()
  const torrents: StorageTorrent[] = []
  for (const t of raw) {
    const files: FileStat[] = []
    if (t.content_path) await walk(t.content_path, files)
    const linked = new Set<string>()
    let linkedBytes = 0
    for (const f of files) {
      torrentInodes.add(f.key)
      const hit = inodeFolders.get(f.key)
      if (!hit) continue
      linkedBytes += f.size
      for (const k of hit) linked.add(k)
    }
    // mal/tmdb ids are global; series:N is per-database and would point a
    // staging torrent at an unrelated prod row, so it is deliberately ignored.
    const tags = parseTorrentTags(t.tags)
    const s =
      (tags.tag_mal_id != null && series.find((r) => r.mal_id === tags.tag_mal_id)) ||
      (tags.tag_tmdb_id != null && series.find((r) => r.source === 'tmdb' && r.source_id === tags.tag_tmdb_id)) ||
      null
    const folderCatalog = [...linked].map((k) => folderByKey.get(k)?.catalog).find(Boolean) ?? null
    torrents.push({
      hash: t.hash,
      name: t.name,
      category: t.category,
      state: t.state,
      progress: t.progress,
      bytes: files.length ? files.reduce((n, f) => n + f.size, 0) : 0,
      linkedBytes,
      folders: [...linked].sort(),
      catalog: s ? { id: s.id, title: s.title } : folderCatalog,
      addedOn: t.added_on,
    })
    for (const k of linked) folderByKey.get(k)?.torrents.push(t.hash)
  }
  for (const [key, files] of folderFiles) {
    const f = folderByKey.get(key)
    if (f) f.linkedBytes = files.reduce((n, x) => n + (torrentInodes.has(x.key) ? x.size : 0), 0)
  }

  // One row per filesystem: the libraries and downloads usually share the NFS
  // export, and listing it three times would read as three disks.
  const probe = [...roots.values(), ...new Set(raw.map((t) => t.save_path).filter((p): p is string => Boolean(p)))]
  const byDev = new Map<number, StorageVolume>()
  for (const p of probe) {
    const v = await volumeOf(p)
    if (!v) continue
    const vol = byDev.get(v.dev)
    if (vol) vol.paths.push(p)
    else byDev.set(v.dev, { paths: [p], totalBytes: v.total, freeBytes: v.free })
  }

  folders.sort((a, b) => b.bytes - a.bytes)
  torrents.sort((a, b) => b.bytes - a.bytes)
  return { volumes: [...byDev.values()], folders, torrents, qbitError, missingRoots }
}

export interface DeleteRequest {
  folders: { section: string; name: string }[]
  torrents: string[]
}

export interface DeleteResult {
  deletedFolders: string[]
  deletedTorrents: number
  errors: string[]
  freedBytes: number | null
}

const HASH_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/

/** Resolve a requested folder to a path strictly one level below its section's
 * library root, or explain why not. The only thing this route may ever remove
 * is a whole top-level library folder — never a root, never outside one. */
export function resolveDeletableFolder(section: string, name: string): string {
  if (!(PORTAL_SECTIONS as readonly string[]).includes(section)) throw new Error(`Unknown section "${section}"`)
  const root = sectionLibraryRoot(section as PortalSection)
  if (!root || !path.isAbsolute(root)) throw new Error(`${section} library root is not set`)
  if (!name || name !== path.basename(name) || name.startsWith('.') || /[\\/]/.test(name)) {
    throw new Error(`"${name}" is not a top-level folder name`)
  }
  const target = path.join(root, name)
  if (path.dirname(target) !== path.resolve(root)) throw new Error(`"${name}" escapes the ${section} library`)
  return target
}

export async function deleteStorage(req: DeleteRequest): Promise<DeleteResult> {
  const errors: string[] = []
  const deletedFolders: string[] = []
  const hashes = [...new Set(req.torrents.map((h) => h.toLowerCase()))]
  const bad = hashes.filter((h) => !HASH_RE.test(h))
  if (bad.length) throw new Error(`Invalid torrent hash: ${bad[0]}`)
  // Validate everything before removing anything.
  const targets = req.folders.map((f) => ({ ...f, abs: resolveDeletableFolder(f.section, f.name) }))

  const before = targets[0] ? await volumeOf(path.dirname(targets[0].abs)) : null

  if (hashes.length) {
    try {
      await qbitDelete(hashes, true)
    } catch (e) {
      errors.push(`qBittorrent: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  for (const t of targets) {
    try {
      const st = await fsp.lstat(t.abs)
      if (!st.isDirectory()) throw new Error('not a directory')
      await fsp.rm(t.abs, { recursive: true })
      forgetLibraryDir(t.name)
      deletedFolders.push(folderKey(t.section, t.name))
    } catch (e) {
      errors.push(`${folderKey(t.section, t.name)}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (deletedFolders.length && jellyfinConfigured()) {
    try {
      const res = await fetch(jfUrl('/Library/Refresh'), { method: 'POST', headers: jfHeaders(), signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    } catch (e) {
      errors.push(`Jellyfin scan: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // qBit deletes asynchronously, so this undercounts torrent-only deletions;
  // it is a sanity number for the toast, not an accounting.
  const after = before && targets[0] ? await volumeOf(path.dirname(targets[0].abs)) : null
  return {
    deletedFolders,
    deletedTorrents: hashes.length,
    errors,
    freedBytes: before && after ? Math.max(0, after.free - before.free) : null,
  }
}
