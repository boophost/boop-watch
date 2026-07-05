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
  db = instance
  return instance
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

export function getHistory(username: string): { item_id: string; watched_at: string }[] {
  return getDb().prepare('SELECT item_id, watched_at FROM watch_history WHERE username = ? ORDER BY watched_at DESC LIMIT 50').all(username) as any[]
}

export function addHistory(username: string, item_id: string) {
  getDb().prepare(`
    INSERT INTO watch_history (username, item_id, watched_at) 
    VALUES (?, ?, datetime('now')) 
    ON CONFLICT(username, item_id) DO UPDATE SET watched_at = datetime('now')
  `).run(username, item_id)
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
