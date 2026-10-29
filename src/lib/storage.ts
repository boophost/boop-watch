// Client for the storage overview + cleanup API (/manage/storage).
import { fetchAuth, parseAuthJson } from '@/lib/api'

export interface CatalogRef {
  id: number
  title: string
}

export interface StorageVolume {
  paths: string[]
  totalBytes: number
  freeBytes: number
}

export interface StorageFolder {
  section: 'anime' | 'tv' | 'movies'
  name: string
  bytes: number
  files: number
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
  folders: string[]
  catalog: CatalogRef | null
  addedOn: number
}

export interface StorageReport {
  volumes: StorageVolume[]
  folders: StorageFolder[]
  torrents: StorageTorrent[]
  qbitError: string | null
  missingRoots: { section: string; root: string }[]
}

export interface DeleteResult {
  deletedFolders: string[]
  deletedTorrents: number
  errors: string[]
  freedBytes: number | null
}

export const folderKey = (f: { section: string; name: string }): string => `${f.section}/${f.name}`

export async function getStorage(): Promise<StorageReport> {
  const r = await fetchAuth('/api/storage')
  const d = await parseAuthJson<StorageReport & { error?: string }>(r)
  if (!r.ok) throw new Error(d.error ?? 'Failed to load storage')
  return d
}

export async function deleteStorage(input: {
  folders: { section: string; name: string }[]
  torrents: string[]
}): Promise<DeleteResult> {
  const r = await fetchAuth('/api/storage/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const d = await parseAuthJson<DeleteResult & { error?: string }>(r)
  if (!r.ok) throw new Error(d.error ?? 'Delete failed')
  return d
}
