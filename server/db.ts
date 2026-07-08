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

    -- Free-text suggestions from logged-in portal users, reviewed in the
    -- /manage "Suggestions" tab. user_id is the Supabase account id; email is
    -- captured at submit time so admins can see who asked without a lookup.
    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      email TEXT,
      body TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_suggestions_created ON suggestions(created_at);

    -- MAL episode titles, cached so the portal can show real episode names
    -- without hitting Jikan on every sync. Keyed by (mal_id, episode number).
    CREATE TABLE IF NOT EXISTS series_episodes (
      mal_id INTEGER NOT NULL,
      number INTEGER NOT NULL,
      title TEXT,
      title_japanese TEXT,
      aired TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (mal_id, number)
    );

    -- Candidate season-banner images per series, gathered from multiple sources
    -- plus admin uploads. Exactly one row per mal_id is 'selected' (the one the
    -- portal serves). Remote candidates store a url; uploads store a local_file
    -- under DATA_DIR/banners.
    CREATE TABLE IF NOT EXISTS series_banners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mal_id INTEGER NOT NULL,
      source TEXT NOT NULL,
      url TEXT,
      local_file TEXT,
      width INTEGER,
      height INTEGER,
      selected INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_banners_mal ON series_banners(mal_id);
    -- Dedupe remote candidates by URL; uploads (url NULL) stay distinct since
    -- SQLite treats NULLs as unequal in a UNIQUE index.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_banners_url ON series_banners(mal_id, url);
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

export interface SuggestionRow {
  id: number
  user_id: string
  email: string | null
  body: string
  resolved: number
  created_at: string
}

export function addSuggestion(user_id: string, email: string | null, body: string): SuggestionRow {
  const info = getDb()
    .prepare('INSERT INTO suggestions (user_id, email, body) VALUES (?, ?, ?)')
    .run(user_id, email, body)
  return getDb().prepare('SELECT * FROM suggestions WHERE id = ?').get(Number(info.lastInsertRowid)) as SuggestionRow
}

/** All suggestions, open ones first, newest within each group. */
export function listSuggestions(): SuggestionRow[] {
  return getDb()
    .prepare('SELECT * FROM suggestions ORDER BY resolved ASC, created_at DESC')
    .all() as SuggestionRow[]
}

export function setSuggestionResolved(id: number, resolved: boolean): SuggestionRow | undefined {
  getDb().prepare('UPDATE suggestions SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, id)
  return getDb().prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as SuggestionRow | undefined
}

export function deleteSuggestion(id: number): boolean {
  return getDb().prepare('DELETE FROM suggestions WHERE id = ?').run(id).changes > 0
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

export interface EpisodeRow {
  number: number
  title: string | null
  title_japanese?: string | null
  aired?: string | null
}

/** How many episode titles are cached for a series (0 = never fetched). */
export function countCachedEpisodes(mal_id: number): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS c FROM series_episodes WHERE mal_id = ?').get(mal_id) as {
      c: number
    }
  ).c
}

/** Cached episode number -> title for a series. */
export function getEpisodeTitles(mal_id: number): Map<number, string> {
  const rows = getDb()
    .prepare('SELECT number, title FROM series_episodes WHERE mal_id = ?')
    .all(mal_id) as { number: number; title: string | null }[]
  return new Map(rows.filter((r) => r.title).map((r) => [r.number, r.title as string]))
}

/** All cached episode rows for a series, ordered by number (the fallback the
 * episodes API serves when Jikan is unreachable). */
export function getCachedEpisodes(mal_id: number): EpisodeRow[] {
  return getDb()
    .prepare(
      'SELECT number, title, title_japanese, aired FROM series_episodes WHERE mal_id = ? ORDER BY number',
    )
    .all(mal_id) as EpisodeRow[]
}

export interface BannerRow {
  id: number
  mal_id: number
  source: string
  url: string | null
  local_file: string | null
  width: number | null
  height: number | null
  selected: number
  added_at: string
}

export function listBanners(mal_id: number): BannerRow[] {
  return getDb()
    .prepare('SELECT * FROM series_banners WHERE mal_id = ? ORDER BY selected DESC, id ASC')
    .all(mal_id) as BannerRow[]
}

export function countBanners(mal_id: number): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS c FROM series_banners WHERE mal_id = ?').get(mal_id) as {
      c: number
    }
  ).c
}

export function getBanner(id: number): BannerRow | undefined {
  return getDb().prepare('SELECT * FROM series_banners WHERE id = ?').get(id) as BannerRow | undefined
}

export function getSelectedBanner(mal_id: number): BannerRow | undefined {
  return getDb()
    .prepare('SELECT * FROM series_banners WHERE mal_id = ? AND selected = 1 LIMIT 1')
    .get(mal_id) as BannerRow | undefined
}

/**
 * Add a banner candidate. Remote candidates dedupe by URL (returns the existing
 * row); uploads (no url) always insert. Never changes the current selection.
 */
export function addBanner(b: {
  mal_id: number
  source: string
  url?: string | null
  local_file?: string | null
  width?: number | null
  height?: number | null
}): BannerRow {
  const db = getDb()
  if (b.url) {
    const existing = db
      .prepare('SELECT * FROM series_banners WHERE mal_id = ? AND url = ?')
      .get(b.mal_id, b.url) as BannerRow | undefined
    if (existing) return existing
  }
  const info = db
    .prepare(
      `INSERT INTO series_banners (mal_id, source, url, local_file, width, height)
       VALUES (@mal_id, @source, @url, @local_file, @width, @height)`,
    )
    .run({
      mal_id: b.mal_id,
      source: b.source,
      url: b.url ?? null,
      local_file: b.local_file ?? null,
      width: b.width ?? null,
      height: b.height ?? null,
    })
  return getBanner(Number(info.lastInsertRowid))!
}

/** Make one candidate the selected banner for its series (clears the rest). */
export function selectBanner(mal_id: number, bannerId: number): boolean {
  const db = getDb()
  const row = db
    .prepare('SELECT id FROM series_banners WHERE id = ? AND mal_id = ?')
    .get(bannerId, mal_id) as { id: number } | undefined
  if (!row) return false
  const tx = db.transaction(() => {
    db.prepare('UPDATE series_banners SET selected = 0 WHERE mal_id = ?').run(mal_id)
    db.prepare('UPDATE series_banners SET selected = 1 WHERE id = ?').run(bannerId)
  })
  tx()
  return true
}

/** Delete a candidate; returns the deleted row (so callers can drop its file). */
export function deleteBanner(mal_id: number, bannerId: number): BannerRow | undefined {
  const row = getBanner(bannerId)
  if (!row || row.mal_id !== mal_id) return undefined
  getDb().prepare('DELETE FROM series_banners WHERE id = ?').run(bannerId)
  return row
}

export function upsertEpisodes(mal_id: number, episodes: EpisodeRow[]): void {
  const stmt = getDb().prepare(`
    INSERT INTO series_episodes (mal_id, number, title, title_japanese, aired, updated_at)
    VALUES (@mal_id, @number, @title, @title_japanese, @aired, datetime('now'))
    ON CONFLICT(mal_id, number) DO UPDATE SET
      title = excluded.title,
      title_japanese = excluded.title_japanese,
      aired = excluded.aired,
      updated_at = excluded.updated_at
  `)
  const tx = getDb().transaction((rows: EpisodeRow[]) => {
    for (const e of rows) {
      if (!Number.isFinite(e.number)) continue
      stmt.run({
        mal_id,
        number: e.number,
        title: e.title ?? null,
        title_japanese: e.title_japanese ?? null,
        aired: e.aired ?? null,
      })
    }
  })
  tx(episodes)
}
