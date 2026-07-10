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
  // Multi-season placement. A single Jellyfin/TVDB show is often several MAL
  // cours (Mushoku Tensei S1c1/S1c2/S2/…), each a separate mal_id row. tvdb_id
  // groups the cours as one show; tvdb_season is the Jellyfin season number the
  // cour's episodes belong to; episode_offset is added to each release's
  // (per-cour) episode number to land it at the right absolute slot in that
  // season (e.g. S1 cour 2 → offset 11). Populated from the season-map dataset
  // unless mapping_source='manual' (an admin override the auto-enrich won't
  // clobber). See server/seasonMap.ts.
  tvdb_id: number | null
  tvdb_season: number | null
  episode_offset: number | null
  mapping_source: string | null // 'auto' | 'manual' | null
  // MAL weekly broadcast (JSON: { day, time, timezone, string }) for estimating
  // next-episode air times when Jikan hasn't listed the episode yet.
  broadcast: string | null
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
  ['tvdb_id', 'INTEGER'],
  ['tvdb_season', 'INTEGER'],
  ['episode_offset', 'INTEGER'],
  ['mapping_source', 'TEXT'],
  ['broadcast', 'TEXT'],
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
  broadcast?: string | null
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

    -- Epics that bundle several related suggestions under one admin-authored
    -- writeup. Suggestions attach via suggestions.group_id (nullable). Created and
    -- edited by admins / the boop-suggestions MCP driver, never by portal users.
    CREATE TABLE IF NOT EXISTS suggestion_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Free-text suggestions from logged-in portal users, reviewed on the
    -- /manage "Suggestions" kanban. user_id is the Supabase account id; email is
    -- captured at submit time so admins can see who asked without a lookup.
    -- status is the kanban column (unread | todo | working | staged | done);
    -- resolved is kept for back-compat and mirrors status = 'done'.
    -- body is the user's verbatim words and is never edited; title and notes
    -- are admin-authored triage/resolution metadata. duplicate_of points at the
    -- canonical suggestion this one duplicates; group_id links it to an epic.
    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      email TEXT,
      body TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unread',
      title TEXT,
      notes TEXT,
      duplicate_of INTEGER,
      group_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_suggestions_created ON suggestions(created_at);
    CREATE INDEX IF NOT EXISTS idx_suggestions_group ON suggestions(group_id);

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

    -- Candidate season art per series, gathered from multiple sources plus admin
    -- uploads. "kind" splits the wide hero ('banner') from the portrait poster
    -- ('poster'); at most one row per (mal_id, kind) is 'selected' (the one the
    -- portal serves). Remote candidates store a url; uploads store a local_file
    -- under DATA_DIR/banners.
    CREATE TABLE IF NOT EXISTS series_banners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mal_id INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'banner',
      source TEXT NOT NULL,
      url TEXT,
      thumb_url TEXT,
      local_file TEXT,
      width INTEGER,
      height INTEGER,
      selected INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_banners_mal ON series_banners(mal_id);
    -- Dedupe remote candidates by URL within a kind; uploads (url NULL) stay
    -- distinct since SQLite treats NULLs as unequal in a UNIQUE index.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_banners_url ON series_banners(mal_id, kind, url);

    -- Per-episode comments on the public player page. item_id is the Jellyfin
    -- episode/movie id (same key as watch progress); user_id is the Supabase
    -- account id. Display name + avatar are still snapshotted at post time as a
    -- fallback, but reads prefer user_profiles (synced on auth) so a later
    -- profile change shows up on existing comments without a Supabase lookup.
    CREATE TABLE IF NOT EXISTS episode_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      avatar_url TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_comments_item ON episode_comments(item_id, created_at);

    -- Cached display identity for comment authors. Upserted on authenticated
    -- requests from Supabase user_metadata so public comment reads can join
    -- current name/avatar/admin without calling Supabase.
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- What sink.library-import placed, and where it came from. Keyed on the
    -- library-relative path because that is what survives: a file rewritten in
    -- place (trim-audio writes to the PVC, so the import copies across
    -- filesystems) gets a fresh inode and loses its hardlink back to the
    -- torrent. Without this row, a file's season/episode can only be guessed
    -- back from its content.
    CREATE TABLE IF NOT EXISTS library_files (
      path TEXT PRIMARY KEY,
      mal_id INTEGER,
      tvdb_id INTEGER,
      tvdb_season INTEGER,
      episode INTEGER,
      torrent_hash TEXT,
      source_path TEXT,
      inode INTEGER,
      size INTEGER,
      method TEXT,
      imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_library_files_ep ON library_files(mal_id, tvdb_season, episode);
    CREATE INDEX IF NOT EXISTS idx_library_files_hash ON library_files(torrent_hash);
    CREATE TABLE IF NOT EXISTS fetch_attempts (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      attempted_at INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
    );
  `)

  // Additive migration for the richer metadata columns.
  const existing = new Set(
    (instance.prepare(`PRAGMA table_info(series)`).all() as { name: string }[]).map((c) => c.name),
  )
  for (const [name, type] of SERIES_EXTRA_COLUMNS) {
    if (!existing.has(name)) instance.exec(`ALTER TABLE series ADD COLUMN ${name} ${type}`)
  }

  // Additive migration: the suggestions kanban `status` column landed after the
  // table already existed on some deployments. Add it, then backfill from the
  // older `resolved` flag so previously-resolved items open in the Done column.
  const suggestionCols = new Set(
    (instance.prepare(`PRAGMA table_info(suggestions)`).all() as { name: string }[]).map((c) => c.name),
  )
  if (!suggestionCols.has('status')) {
    instance.exec(`ALTER TABLE suggestions ADD COLUMN status TEXT NOT NULL DEFAULT 'todo'`)
    instance.exec(`UPDATE suggestions SET status = 'done' WHERE resolved = 1`)
  }
  // Additive migration: admin triage metadata (title/notes), duplicate links, and
  // epic grouping landed with the boop-suggestions MCP driver. All nullable, so a
  // plain ADD COLUMN backfills existing rows with NULL (untriaged, ungrouped).
  for (const [name, type] of [
    ['title', 'TEXT'],
    ['notes', 'TEXT'],
    ['duplicate_of', 'INTEGER'],
    ['group_id', 'INTEGER'],
    ['updated_at', 'TEXT'],
  ] as const) {
    if (!suggestionCols.has(name)) instance.exec(`ALTER TABLE suggestions ADD COLUMN ${name} ${type}`)
  }

  // Additive migration: `thumb_url` arrived with the provider-artwork sources,
  // whose candidate lists are far too large to cache in full (see banners.ts).
  const bannerCols = new Set(
    (instance.prepare(`PRAGMA table_info(series_banners)`).all() as { name: string }[]).map((c) => c.name),
  )
  if (!bannerCols.has('thumb_url')) {
    instance.exec(`ALTER TABLE series_banners ADD COLUMN thumb_url TEXT`)
  }
  // `kind` splits banners from posters. The dedupe index has to widen with it,
  // or a poster could never share a URL with its series' banner. An existing DB
  // still carries the two-column index under the same name, so replace it.
  if (!bannerCols.has('kind')) {
    instance.exec(`ALTER TABLE series_banners ADD COLUMN kind TEXT NOT NULL DEFAULT 'banner'`)
    instance.exec(`DROP INDEX IF EXISTS idx_banners_url`)
    instance.exec(`CREATE UNIQUE INDEX idx_banners_url ON series_banners(mal_id, kind, url)`)
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
  const assignments = [
    ...cols.map((c) => `${c} = @${c}`),
    // Fill the base presentation fields when the row is missing them (rows
    // added by id-only paths — flows, the CLI — have no poster/synopsis until
    // an enrich runs). Never overwrites an existing value.
    `synopsis = COALESCE(synopsis, @b_synopsis)`,
    `image_url = COALESCE(image_url, @b_image_url)`,
    `url = COALESCE(url, @b_url)`,
    `metadata_updated_at = datetime('now')`,
  ]
  db.prepare(`UPDATE series SET ${assignments.join(', ')} WHERE mal_id = @mal_id`).run({
    ...meta,
    mal_id: base.mal_id,
    b_synopsis: base.synopsis ?? null,
    b_image_url: base.image_url ?? null,
    b_url: base.url ?? null,
  })
  return findByMalId(base.mal_id)!
}

/**
 * Set (or clear) the multi-season placement mapping on a catalog row. `source`
 * distinguishes an admin override ('manual') from a dataset-derived value
 * ('auto'); callers doing an auto-enrich must not overwrite a 'manual' row (see
 * seasonMap.enrichSeasonMapping). Pass null fields to clear.
 */
export function setSeasonMapping(
  mal_id: number,
  m: { tvdb_id?: number | null; tvdb_season?: number | null; episode_offset?: number | null; source?: string | null },
): SeriesRow | undefined {
  getDb()
    .prepare(
      `UPDATE series SET
         tvdb_id = @tvdb_id,
         tvdb_season = @tvdb_season,
         episode_offset = @episode_offset,
         mapping_source = @mapping_source
       WHERE mal_id = @mal_id`,
    )
    .run({
      mal_id,
      tvdb_id: m.tvdb_id ?? null,
      tvdb_season: m.tvdb_season ?? null,
      episode_offset: m.episode_offset ?? null,
      mapping_source: m.source ?? null,
    })
  return findByMalId(mal_id)
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

export type SuggestionStatus = 'unread' | 'todo' | 'working' | 'staged' | 'done'
export const SUGGESTION_STATUSES: SuggestionStatus[] = ['unread', 'todo', 'working', 'staged', 'done']

export interface SuggestionRow {
  id: number
  user_id: string
  email: string | null
  body: string
  resolved: number
  status: SuggestionStatus
  /** Admin-authored short title (the user's `body` stays verbatim). */
  title: string | null
  /** Admin-authored triage / resolution notes. */
  notes: string | null
  /** Canonical suggestion id this one duplicates, or null. */
  duplicate_of: number | null
  /** Epic (suggestion_groups.id) this belongs to, or null. */
  group_id: number | null
  created_at: string
  updated_at: string | null
}

export interface SuggestionGroupRow {
  id: number
  title: string
  description: string | null
  created_at: string
  updated_at: string
}

export function addSuggestion(user_id: string, email: string | null, body: string): SuggestionRow {
  // Land new suggestions in the 'unread' column explicitly — DBs that migrated
  // the status column earlier baked in a 'todo' default we don't want to inherit.
  const info = getDb()
    .prepare("INSERT INTO suggestions (user_id, email, body, status) VALUES (?, ?, ?, 'unread')")
    .run(user_id, email, body)
  return getDb().prepare('SELECT * FROM suggestions WHERE id = ?').get(Number(info.lastInsertRowid)) as SuggestionRow
}

/** All suggestions, newest first (the board groups them into columns client-side). */
export function listSuggestions(): SuggestionRow[] {
  return getDb()
    .prepare('SELECT * FROM suggestions ORDER BY created_at DESC')
    .all() as SuggestionRow[]
}

export function getSuggestion(id: number): SuggestionRow | undefined {
  return getDb().prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as SuggestionRow | undefined
}

/** Fields an admin (or the MCP driver) may edit on a suggestion. `body` is never
 * editable — it's the user's verbatim words. Every key is optional; only the ones
 * present in the patch are written. Pass `null` to clear a nullable field. */
export interface SuggestionPatch {
  status?: SuggestionStatus
  title?: string | null
  notes?: string | null
  duplicate_of?: number | null
  group_id?: number | null
}

/**
 * Apply a partial edit to a suggestion. `resolved` is kept in sync with status
 * (= 'done'), and `updated_at` is stamped. Returns the fresh row, or undefined if
 * the id doesn't exist.
 */
export function updateSuggestion(id: number, patch: SuggestionPatch): SuggestionRow | undefined {
  const existing = getSuggestion(id)
  if (!existing) return undefined
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.status !== undefined) {
    sets.push('status = ?', 'resolved = ?')
    vals.push(patch.status, patch.status === 'done' ? 1 : 0)
  }
  if (patch.title !== undefined) {
    sets.push('title = ?')
    vals.push(patch.title)
  }
  if (patch.notes !== undefined) {
    sets.push('notes = ?')
    vals.push(patch.notes)
  }
  if (patch.duplicate_of !== undefined) {
    sets.push('duplicate_of = ?')
    vals.push(patch.duplicate_of)
  }
  if (patch.group_id !== undefined) {
    sets.push('group_id = ?')
    vals.push(patch.group_id)
  }
  if (sets.length === 0) return existing
  sets.push("updated_at = datetime('now')")
  getDb().prepare(`UPDATE suggestions SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  return getSuggestion(id)
}

/** Back-compat shim for the status-only move (kanban drag). */
export function setSuggestionStatus(id: number, status: SuggestionStatus): SuggestionRow | undefined {
  return updateSuggestion(id, { status })
}

export function deleteSuggestion(id: number): boolean {
  const db = getDb()
  return db.transaction((): boolean => {
    // Don't leave dangling references: clear this id from any suggestion that
    // pointed at it as a duplicate canonical.
    db.prepare('UPDATE suggestions SET duplicate_of = NULL WHERE duplicate_of = ?').run(id)
    return db.prepare('DELETE FROM suggestions WHERE id = ?').run(id).changes > 0
  })()
}

// --- Suggestion groups (epics) ---------------------------------------------

export function listSuggestionGroups(): SuggestionGroupRow[] {
  return getDb()
    .prepare('SELECT * FROM suggestion_groups ORDER BY created_at DESC')
    .all() as SuggestionGroupRow[]
}

export function getSuggestionGroup(id: number): SuggestionGroupRow | undefined {
  return getDb().prepare('SELECT * FROM suggestion_groups WHERE id = ?').get(id) as SuggestionGroupRow | undefined
}

export function addSuggestionGroup(title: string, description: string | null): SuggestionGroupRow {
  const info = getDb()
    .prepare('INSERT INTO suggestion_groups (title, description) VALUES (?, ?)')
    .run(title, description)
  return getSuggestionGroup(Number(info.lastInsertRowid))!
}

export function updateSuggestionGroup(
  id: number,
  patch: { title?: string; description?: string | null },
): SuggestionGroupRow | undefined {
  const existing = getSuggestionGroup(id)
  if (!existing) return undefined
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.title !== undefined) {
    sets.push('title = ?')
    vals.push(patch.title)
  }
  if (patch.description !== undefined) {
    sets.push('description = ?')
    vals.push(patch.description)
  }
  if (sets.length === 0) return existing
  sets.push("updated_at = datetime('now')")
  getDb().prepare(`UPDATE suggestion_groups SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  return getSuggestionGroup(id)
}

/** Delete an epic; detach (not delete) its member suggestions. */
export function deleteSuggestionGroup(id: number): boolean {
  const db = getDb()
  return db.transaction((): boolean => {
    db.prepare('UPDATE suggestions SET group_id = NULL WHERE group_id = ?').run(id)
    return db.prepare('DELETE FROM suggestion_groups WHERE id = ?').run(id).changes > 0
  })()
}

export interface CommentRow {
  id: number
  item_id: string
  user_id: string
  user_name: string
  avatar_url: string | null
  body: string
  created_at: string
  /** 1 when the author is currently an admin (from user_profiles join). */
  is_admin: number
}

export interface UserProfileRow {
  user_id: string
  display_name: string
  avatar_url: string | null
  is_admin: number
  updated_at: string
}

// Prefer the live profile cache when present; fall back to the write-time
// snapshot for authors who haven't authenticated since profiles were added.
const COMMENT_SELECT = `
  SELECT
    c.id, c.item_id, c.user_id, c.body, c.created_at,
    CASE WHEN p.user_id IS NOT NULL THEN p.display_name ELSE c.user_name END AS user_name,
    CASE WHEN p.user_id IS NOT NULL THEN p.avatar_url ELSE c.avatar_url END AS avatar_url,
    COALESCE(p.is_admin, 0) AS is_admin
  FROM episode_comments c
  LEFT JOIN user_profiles p ON p.user_id = c.user_id
`

/** Comments on one episode/movie, newest first. */
export function listComments(item_id: string): CommentRow[] {
  return getDb()
    .prepare(`${COMMENT_SELECT} WHERE c.item_id = ? ORDER BY c.id DESC`)
    .all(item_id) as CommentRow[]
}

export function addComment(c: {
  item_id: string
  user_id: string
  user_name: string
  avatar_url: string | null
  body: string
}): CommentRow {
  const info = getDb()
    .prepare(
      'INSERT INTO episode_comments (item_id, user_id, user_name, avatar_url, body) VALUES (?, ?, ?, ?, ?)',
    )
    .run(c.item_id, c.user_id, c.user_name, c.avatar_url, c.body)
  return getComment(Number(info.lastInsertRowid))!
}

export function getComment(id: number): CommentRow | undefined {
  return getDb().prepare(`${COMMENT_SELECT} WHERE c.id = ?`).get(id) as CommentRow | undefined
}

export function deleteComment(id: number): boolean {
  return getDb().prepare('DELETE FROM episode_comments WHERE id = ?').run(id).changes > 0
}

export function upsertUserProfile(p: {
  user_id: string
  display_name: string
  avatar_url: string | null
  is_admin: boolean
}): void {
  getDb()
    .prepare(
      `INSERT INTO user_profiles (user_id, display_name, avatar_url, is_admin, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         display_name = excluded.display_name,
         avatar_url = excluded.avatar_url,
         is_admin = excluded.is_admin,
         updated_at = datetime('now')`,
    )
    .run(p.user_id, p.display_name, p.avatar_url, p.is_admin ? 1 : 0)
}

/** Keep the comment-author admin badge in sync when /manage toggles admin. */
export function setUserProfileAdmin(user_id: string, is_admin: boolean): void {
  getDb()
    .prepare(
      `UPDATE user_profiles SET is_admin = ?, updated_at = datetime('now') WHERE user_id = ?`,
    )
    .run(is_admin ? 1 : 0, user_id)
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

// Throttle ledger for external fetches (banner gathers, poster searches,
// episode-title fetches). Persisted so a pod restart doesn't refire every
// gather at once — deploys roll the pod many times a day, and the old
// in-process maps made each roll a burst of AniList/Kitsu/fanart/Jikan
// requests (observed 429s when dev and prod rolled together).
/** Last recorded attempt (ms epoch) for a throttled fetch, or 0 if never tried. */
export function lastFetchAttempt(kind: string, key: string): number {
  const row = getDb()
    .prepare('SELECT attempted_at FROM fetch_attempts WHERE kind = ? AND key = ?')
    .get(kind, key) as { attempted_at: number } | undefined
  return row?.attempted_at ?? 0
}

export function recordFetchAttempt(kind: string, key: string): void {
  getDb()
    .prepare(
      `INSERT INTO fetch_attempts (kind, key, attempted_at) VALUES (?, ?, ?)
       ON CONFLICT (kind, key) DO UPDATE SET attempted_at = excluded.attempted_at`,
    )
    .run(kind, key, Date.now())
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

/** The two art kinds a cour can carry: the wide hero and the portrait poster. */
export type ArtKind = 'banner' | 'poster'

export const isArtKind = (v: unknown): v is ArtKind => v === 'banner' || v === 'poster'

export interface BannerRow {
  id: number
  mal_id: number
  kind: ArtKind
  source: string
  url: string | null
  /** A small preview of `url`, when the source offers one. Never cached to disk. */
  thumb_url: string | null
  local_file: string | null
  width: number | null
  height: number | null
  selected: number
  added_at: string
}

export function listBanners(mal_id: number, kind: ArtKind = 'banner'): BannerRow[] {
  return getDb()
    .prepare('SELECT * FROM series_banners WHERE mal_id = ? AND kind = ? ORDER BY selected DESC, id ASC')
    .all(mal_id, kind) as BannerRow[]
}

export function getBanner(id: number): BannerRow | undefined {
  return getDb().prepare('SELECT * FROM series_banners WHERE id = ?').get(id) as BannerRow | undefined
}

export function getSelectedBanner(mal_id: number, kind: ArtKind = 'banner'): BannerRow | undefined {
  return getDb()
    .prepare('SELECT * FROM series_banners WHERE mal_id = ? AND kind = ? AND selected = 1 LIMIT 1')
    .get(mal_id, kind) as BannerRow | undefined
}

/**
 * Add an art candidate. Remote candidates dedupe by URL within their kind
 * (returns the existing row); uploads (no url) always insert. Never changes the
 * current selection.
 */
export function addBanner(b: {
  mal_id: number
  kind?: ArtKind
  source: string
  url?: string | null
  thumb_url?: string | null
  local_file?: string | null
  width?: number | null
  height?: number | null
}): BannerRow {
  const db = getDb()
  const kind = b.kind ?? 'banner'
  if (b.url) {
    const existing = db
      .prepare('SELECT * FROM series_banners WHERE mal_id = ? AND kind = ? AND url = ?')
      .get(b.mal_id, kind, b.url) as BannerRow | undefined
    if (existing) return existing
  }
  const info = db
    .prepare(
      `INSERT INTO series_banners (mal_id, kind, source, url, thumb_url, local_file, width, height)
       VALUES (@mal_id, @kind, @source, @url, @thumb_url, @local_file, @width, @height)`,
    )
    .run({
      mal_id: b.mal_id,
      kind,
      source: b.source,
      url: b.url ?? null,
      thumb_url: b.thumb_url ?? null,
      local_file: b.local_file ?? null,
      width: b.width ?? null,
      height: b.height ?? null,
    })
  return getBanner(Number(info.lastInsertRowid))!
}

export interface LibraryFileRow {
  path: string
  mal_id: number | null
  tvdb_id: number | null
  tvdb_season: number | null
  episode: number | null
  torrent_hash: string | null
  source_path: string | null
  inode: number | null
  size: number | null
  method: string | null
  imported_at: string
}

/** Record (or re-record) what a library path holds. Re-importing the same path
 * overwrites the row, so the ledger always describes the file that is there. */
export function recordLibraryFile(row: Omit<LibraryFileRow, 'imported_at'>): void {
  getDb()
    .prepare(
      `INSERT INTO library_files (path, mal_id, tvdb_id, tvdb_season, episode, torrent_hash, source_path, inode, size, method, imported_at)
       VALUES (@path, @mal_id, @tvdb_id, @tvdb_season, @episode, @torrent_hash, @source_path, @inode, @size, @method, datetime('now'))
       ON CONFLICT(path) DO UPDATE SET
         mal_id=excluded.mal_id, tvdb_id=excluded.tvdb_id, tvdb_season=excluded.tvdb_season,
         episode=excluded.episode, torrent_hash=excluded.torrent_hash, source_path=excluded.source_path,
         inode=excluded.inode, size=excluded.size, method=excluded.method, imported_at=datetime('now')`,
    )
    .run(row)
}

/** Drop a ledger row (the file was removed or superseded under another name). */
export function forgetLibraryFile(p: string): void {
  getDb().prepare('DELETE FROM library_files WHERE path = ?').run(p)
}

export function getLibraryFile(p: string): LibraryFileRow | undefined {
  return getDb().prepare('SELECT * FROM library_files WHERE path = ?').get(p) as LibraryFileRow | undefined
}

export function listLibraryFiles(): LibraryFileRow[] {
  return getDb().prepare('SELECT * FROM library_files ORDER BY path').all() as LibraryFileRow[]
}

/** Record the on-disk copy of a candidate's art (see banners.ts `cacheBannerFile`). */
export function setBannerLocalFile(bannerId: number, local_file: string): void {
  getDb().prepare('UPDATE series_banners SET local_file = ? WHERE id = ?').run(local_file, bannerId)
}

/**
 * Make one candidate the selected art for its series. Clears only the rest of
 * *its own kind* — a series' banner and poster are selected independently.
 */
export function selectBanner(mal_id: number, bannerId: number): boolean {
  const db = getDb()
  const row = db
    .prepare('SELECT id, kind FROM series_banners WHERE id = ? AND mal_id = ?')
    .get(bannerId, mal_id) as { id: number; kind: ArtKind } | undefined
  if (!row) return false
  const tx = db.transaction(() => {
    db.prepare('UPDATE series_banners SET selected = 0 WHERE mal_id = ? AND kind = ?').run(mal_id, row.kind)
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
