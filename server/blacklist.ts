// Blacklisted torrent releases, stored in series.sqlite. The flow's torrent
// search skips any candidate whose info-hash is blacklisted, so a bad source
// (wrong content, fake, dead) never gets re-picked on the next run.

import { getDb } from './db.js'

export interface BlacklistRow {
  id: number
  info_hash: string
  name: string | null
  series_id: number | null
  reason: string | null
  created_at: string
}

let ready = false

function db() {
  const instance = getDb()
  if (!ready) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS torrent_blacklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        info_hash TEXT NOT NULL UNIQUE,
        name TEXT,
        series_id INTEGER,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_blacklist_series ON torrent_blacklist(series_id);
    `)
    ready = true
  }
  return instance
}

const normHash = (h: string): string => h.trim().toLowerCase()

export function listBlacklist(seriesId?: number): BlacklistRow[] {
  if (seriesId != null) {
    return db()
      .prepare('SELECT * FROM torrent_blacklist WHERE series_id = ? ORDER BY created_at DESC')
      .all(seriesId) as BlacklistRow[]
  }
  return db().prepare('SELECT * FROM torrent_blacklist ORDER BY created_at DESC').all() as BlacklistRow[]
}

export function addBlacklist(entry: {
  info_hash: string
  name?: string | null
  series_id?: number | null
  reason?: string | null
}): BlacklistRow {
  const hash = normHash(entry.info_hash)
  db()
    .prepare(
      `INSERT INTO torrent_blacklist (info_hash, name, series_id, reason)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(info_hash) DO UPDATE SET
         name = COALESCE(excluded.name, torrent_blacklist.name),
         series_id = COALESCE(excluded.series_id, torrent_blacklist.series_id),
         reason = COALESCE(excluded.reason, torrent_blacklist.reason)`,
    )
    .run(hash, entry.name ?? null, entry.series_id ?? null, entry.reason ?? null)
  return db().prepare('SELECT * FROM torrent_blacklist WHERE info_hash = ?').get(hash) as BlacklistRow
}

export function removeBlacklist(id: number): boolean {
  return db().prepare('DELETE FROM torrent_blacklist WHERE id = ?').run(id).changes > 0
}

/** Lowercased info-hashes, for the torrent-search node to filter against. */
export function blacklistedHashes(): Set<string> {
  const rows = db().prepare('SELECT info_hash FROM torrent_blacklist').all() as { info_hash: string }[]
  return new Set(rows.map((r) => r.info_hash))
}
