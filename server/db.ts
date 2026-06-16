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
  `)
  db = instance
  return instance
}

export function listSeries(): SeriesRow[] {
  return getDb()
    .prepare('SELECT * FROM series ORDER BY added_at DESC')
    .all() as SeriesRow[]
}

export function insertSeries(
  row: Omit<SeriesRow, 'id' | 'added_at'>,
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
