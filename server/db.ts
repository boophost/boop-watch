import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
const dbPath = process.env.DATABASE_PATH ?? path.join(dataDir, 'series.sqlite')

export interface SeriesRow {
  id: number
  mal_id: number
  title: string
  synopsis: string | null
  image_url: string | null
  url: string | null
  added_at: string
  // Richer metadata (populated by the enrich.metadata flow node) — the
  // groundwork for our own catalog to replace Jellyfin as the source of truth.
  title_english: string | null
  title_japanese: string | null
  type: string | null
  episodes: number | null
  status: string | null
  score: number | null
  year: number | null
  season: string | null
  aired: string | null
  studios: string | null // JSON array of names
  genres: string | null // JSON array of names
  metadata_updated_at: string | null
}

// Columns added after the original 5-field schema. Applied as additive ALTERs so
// existing series.sqlite files migrate in place (ADD COLUMN is a no-op-safe when
// guarded by the table_info check below).
const SERIES_EXTRA_COLUMNS: [string, string][] = [
  ['title_english', 'TEXT'],
  ['title_japanese', 'TEXT'],
  ['type', 'TEXT'],
  ['episodes', 'INTEGER'],
  ['status', 'TEXT'],
  ['score', 'REAL'],
  ['year', 'INTEGER'],
  ['season', 'TEXT'],
  ['aired', 'TEXT'],
  ['studios', 'TEXT'],
  ['genres', 'TEXT'],
  ['metadata_updated_at', 'TEXT'],
]

export interface SeriesMetadata {
  title_english?: string | null
  title_japanese?: string | null
  type?: string | null
  episodes?: number | null
  status?: string | null
  score?: number | null
  year?: number | null
  season?: string | null
  aired?: string | null
  studios?: string | null
  genres?: string | null
}

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const instance = new Database(dbPath)
  instance.exec(`
    CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mal_id INTEGER NOT NULL UNIQUE,
      title TEXT NOT NULL,
      synopsis TEXT,
      image_url TEXT,
      url TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_series_mal_id ON series(mal_id);

    CREATE TABLE IF NOT EXISTS saved_animes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      item_id TEXT NOT NULL,
      added_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(username, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_animes(username);

    CREATE TABLE IF NOT EXISTS watch_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      item_id TEXT NOT NULL,
      watched_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(username, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_history_user ON watch_history(username);
  `)

  // Additive migration for the richer metadata columns.
  const existing = new Set(
    (instance.prepare(`PRAGMA table_info(series)`).all() as { name: string }[]).map((c) => c.name),
  )
  for (const [name, type] of SERIES_EXTRA_COLUMNS) {
    if (!existing.has(name)) instance.exec(`ALTER TABLE series ADD COLUMN ${name} ${type}`)
  }

  db = instance
  return instance
}

/**
 * Upsert a catalog series by mal_id and set its richer metadata. Creates the
 * row (with title/synopsis/image/url) if the mal_id is new, otherwise updates
 * only the provided metadata fields. Returns the resulting row.
 */
export function upsertSeriesMetadata(
  base: { mal_id: number; title: string; synopsis?: string | null; image_url?: string | null; url?: string | null },
  meta: SeriesMetadata,
): SeriesRow {
  const db = getDb()
  const existing = findByMalId(base.mal_id)
  if (!existing) {
    db.prepare(
      `INSERT INTO series (mal_id, title, synopsis, image_url, url) VALUES (@mal_id, @title, @synopsis, @image_url, @url)`,
    ).run({
      mal_id: base.mal_id,
      title: base.title,
      synopsis: base.synopsis ?? null,
      image_url: base.image_url ?? null,
      url: base.url ?? null,
    })
  }
  const cols = Object.keys(meta).filter((k) => (meta as Record<string, unknown>)[k] !== undefined)
  const assignments = [...cols.map((c) => `${c} = @${c}`), `metadata_updated_at = datetime('now')`]
  db.prepare(`UPDATE series SET ${assignments.join(', ')} WHERE mal_id = @mal_id`).run({
    ...meta,
    mal_id: base.mal_id,
  })
  return findByMalId(base.mal_id)!
}

export function getSavedAnimes(username: string): { item_id: string; added_at: string }[] {
  return getDb().prepare('SELECT item_id, added_at FROM saved_animes WHERE username = ? ORDER BY added_at DESC').all(username) as any[]
}

export function saveAnime(username: string, item_id: string) {
  getDb().prepare('INSERT OR IGNORE INTO saved_animes (username, item_id) VALUES (?, ?)').run(username, item_id)
}

export function unsaveAnime(username: string, item_id: string) {
  getDb().prepare('DELETE FROM saved_animes WHERE username = ? AND item_id = ?').run(username, item_id)
}

export function listSeries(): SeriesRow[] {
  return getDb()
    .prepare('SELECT * FROM series ORDER BY added_at DESC')
    .all() as SeriesRow[]
}

export function insertSeries(
  row: Pick<SeriesRow, 'mal_id' | 'title' | 'synopsis' | 'image_url' | 'url'>,
): SeriesRow {
  const stmt = getDb().prepare(`
    INSERT INTO series (mal_id, title, synopsis, image_url, url)
    VALUES (@mal_id, @title, @synopsis, @image_url, @url)
  `)
  const info = stmt.run(row)
  const id = Number(info.lastInsertRowid)
  return getDb().prepare('SELECT * FROM series WHERE id = ?').get(id) as SeriesRow
}

export function deleteSeries(id: number): boolean {
  const r = getDb().prepare('DELETE FROM series WHERE id = ?').run(id)
  return r.changes > 0
}

export function findByMalId(mal_id: number): SeriesRow | undefined {
  return getDb().prepare('SELECT * FROM series WHERE mal_id = ?').get(mal_id) as
    | SeriesRow
    | undefined
}

export function getSeriesById(id: number): SeriesRow | undefined {
  return getDb().prepare('SELECT * FROM series WHERE id = ?').get(id) as
    | SeriesRow
    | undefined
}
