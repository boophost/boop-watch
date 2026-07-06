import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')
const dbPath = path.join(dataDir, 'portal.sqlite')

export interface PortalItem {
  id: string
  type: string
  name: string
  original_title: string | null
  overview: string | null
  date_created: string | null
  premiere_date: string | null
  production_year: number | null
  genres: string | null // JSON string array
  runtime_ticks: number | null
  index_number: number | null
  parent_index_number: number | null
  series_id: string | null
  series_name: string | null
  image_url: string | null
  backdrop_url: string | null
  has_backdrop: number | null
  mal_id: number | null
}

let db: Database.Database | null = null

export function getPortalDb(): Database.Database {
  if (db) return db
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const instance = new Database(dbPath)
  instance.pragma('journal_mode = WAL')
  instance.exec(`
    CREATE TABLE IF NOT EXISTS portal_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      original_title TEXT,
      overview TEXT,
      date_created TEXT,
      premiere_date TEXT,
      production_year INTEGER,
      genres TEXT,
      runtime_ticks INTEGER,
      index_number INTEGER,
      parent_index_number INTEGER,
      series_id TEXT,
      series_name TEXT,
      image_url TEXT,
      backdrop_url TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_portal_type ON portal_items(type);
    CREATE INDEX IF NOT EXISTS idx_portal_series_id ON portal_items(series_id);
  `)
  try {
    instance.exec('ALTER TABLE portal_items ADD COLUMN has_backdrop INTEGER DEFAULT 1');
  } catch (e) {
    // ignore if already exists
  }
  try {
    // Link a portal series/movie back to its catalog series, so the portal can
    // resolve the admin-selected banner (series_banners) at request time.
    instance.exec('ALTER TABLE portal_items ADD COLUMN mal_id INTEGER');
  } catch (e) {
    // ignore if already exists
  }
  db = instance
  return instance
}

export function getAllPortalItems(): PortalItem[] {
  return getPortalDb().prepare('SELECT * FROM portal_items').all() as PortalItem[]
}

export function getPortalCollectionItems(): PortalItem[] {
  return getPortalDb().prepare("SELECT * FROM portal_items WHERE type IN ('Series', 'Movie')").all() as PortalItem[]
}

export function getPortalScopeEpisodes(): PortalItem[] {
  return getPortalDb().prepare("SELECT * FROM portal_items WHERE type = 'Episode'").all() as PortalItem[]
}

export function getPortalPlayableIds(): Set<string> {
  const rows = getPortalDb().prepare("SELECT id FROM portal_items WHERE type IN ('Episode', 'Movie')").all() as {id: string}[]
  return new Set(rows.map(r => r.id))
}

export function getPortalItem(id: string): PortalItem | undefined {
  return getPortalDb().prepare('SELECT * FROM portal_items WHERE id = ?').get(id) as PortalItem | undefined
}

export function getPortalEpisodes(seriesId: string): PortalItem[] {
  return getPortalDb().prepare('SELECT * FROM portal_items WHERE type = ? AND series_id = ? ORDER BY parent_index_number ASC, index_number ASC').all('Episode', seriesId) as PortalItem[]
}

export function upsertPortalItem(item: PortalItem) {
  const stmt = getPortalDb().prepare(`
    INSERT INTO portal_items (
      id, type, name, original_title, overview, date_created, premiere_date,
      production_year, genres, runtime_ticks, index_number, parent_index_number,
      series_id, series_name, image_url, backdrop_url, has_backdrop, mal_id
    ) VALUES (
      @id, @type, @name, @original_title, @overview, @date_created, @premiere_date,
      @production_year, @genres, @runtime_ticks, @index_number, @parent_index_number,
      @series_id, @series_name, @image_url, @backdrop_url, @has_backdrop, @mal_id
    )
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      name = excluded.name,
      original_title = excluded.original_title,
      overview = excluded.overview,
      date_created = excluded.date_created,
      premiere_date = excluded.premiere_date,
      production_year = excluded.production_year,
      genres = excluded.genres,
      runtime_ticks = excluded.runtime_ticks,
      index_number = excluded.index_number,
      parent_index_number = excluded.parent_index_number,
      series_id = excluded.series_id,
      series_name = excluded.series_name,
      image_url = COALESCE(portal_items.image_url, excluded.image_url),
      backdrop_url = COALESCE(portal_items.backdrop_url, excluded.backdrop_url),
      has_backdrop = excluded.has_backdrop,
      mal_id = COALESCE(excluded.mal_id, portal_items.mal_id)
  `)
  stmt.run(item)
}

export function setImageUrls(id: string, image_url: string | null, backdrop_url: string | null) {
  getPortalDb().prepare('UPDATE portal_items SET image_url = ?, backdrop_url = ? WHERE id = ?').run(image_url, backdrop_url, id)
}
