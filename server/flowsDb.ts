// Flow persistence in series.sqlite. On first use the table is seeded with a
// flow that mirrors the hardcoded image-sourcing chain in sync.ts, so the
// editor opens onto something real instead of a blank canvas.

import { getDb } from './db.js'
import type { FlowGraph } from './flowExecutor.js'

export interface FlowRow {
  id: number
  name: string
  description: string | null
  graph: string // JSON FlowGraph
  created_at: string
  updated_at: string
}

export interface FlowSummary {
  id: number
  name: string
  description: string | null
  node_count: number
  updated_at: string
}

let ready = false

function db() {
  const instance = getDb()
  if (!ready) {
    instance.exec(`
      CREATE TABLE IF NOT EXISTS flows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        graph TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    ready = true
    seedFlows(instance)
  }
  return instance
}

// The sync.ts image-sourcing chain as a graph: items missing art that Jellyfin
// can't supply go through the indexer-title match, then Jikan, and every
// branch converges on the portal write.
const SEED_GRAPH: FlowGraph = {
  nodes: [
    { id: 'src', type: 'source.jellyfin', position: { x: 0, y: 160 }, config: { itemTypes: 'Movie,Series' } },
    { id: 'noimg', type: 'filter.field', position: { x: 280, y: 60 }, config: { field: 'image_url', mode: 'empty', value: '' } },
    { id: 'nojf', type: 'filter.field', position: { x: 560, y: 0 }, config: { field: 'has_primary_image', mode: 'equals', value: '0' } },
    { id: 'match', type: 'enrich.indexer-match', position: { x: 840, y: 0 }, config: { setField: 'image_url', fromField: 'image_url' } },
    { id: 'jikan', type: 'enrich.jikan', position: { x: 1120, y: 60 }, config: { setField: 'image_url', queryField: 'name', maxItems: 25 } },
    { id: 'merge', type: 'combine.merge', position: { x: 1400, y: 220 }, config: {} },
    { id: 'sink', type: 'sink.portal-upsert', position: { x: 1660, y: 220 }, config: {} },
  ],
  edges: [
    { id: 'e1', source: 'src', sourceHandle: 'items', target: 'noimg', targetHandle: 'in' },
    { id: 'e2', source: 'noimg', sourceHandle: 'pass', target: 'nojf', targetHandle: 'in' },
    { id: 'e3', source: 'noimg', sourceHandle: 'fail', target: 'merge', targetHandle: 'in' },
    { id: 'e4', source: 'nojf', sourceHandle: 'pass', target: 'match', targetHandle: 'in' },
    { id: 'e5', source: 'nojf', sourceHandle: 'fail', target: 'merge', targetHandle: 'in' },
    { id: 'e6', source: 'match', sourceHandle: 'matched', target: 'merge', targetHandle: 'in' },
    { id: 'e7', source: 'match', sourceHandle: 'unmatched', target: 'jikan', targetHandle: 'in' },
    { id: 'e8', source: 'jikan', sourceHandle: 'found', target: 'merge', targetHandle: 'in' },
    { id: 'e9', source: 'jikan', sourceHandle: 'missed', target: 'merge', targetHandle: 'in' },
    { id: 'e10', source: 'merge', sourceHandle: 'items', target: 'sink', targetHandle: 'in' },
  ],
}

// Indexer titles that Jellyfin doesn't have → look up airing status → torrent
// search (season pack if finished, recent episodes if airing; 1080p, dual audio
// preferred, seeded) → qBittorrent. Ends at qbit; never touches the portal DB.
const MISSING_VIDEOS_GRAPH: FlowGraph = {
  nodes: [
    { id: 'idx', type: 'source.indexer', position: { x: 0, y: 0 }, config: {} },
    { id: 'por', type: 'source.portal', position: { x: 0, y: 240 }, config: { type: '' } },
    { id: 'diff', type: 'combine.diff', position: { x: 280, y: 110 }, config: { fieldA: 'title', fieldB: 'name', fieldB2: 'original_title' } },
    { id: 'lim', type: 'filter.limit', position: { x: 560, y: 60 }, config: { count: 5 } },
    { id: 'st', type: 'enrich.anime-status', position: { x: 820, y: 60 }, config: { malField: 'mal_id', maxItems: 0 } },
    { id: 'tpl', type: 'transform.template', position: { x: 1100, y: 20 }, config: { field: 'torrent_query', template: '{title} 1080p' } },
    { id: 'tor', type: 'enrich.torrent-search', position: { x: 1380, y: 20 }, config: { provider: 'animetosho', queryField: 'torrent_query', mode: 'auto', resolution: '1080p', requireResolution: false, preferDualAudio: true, requireDualAudio: false, minSeeders: 1, minTitleMatch: 0.5, maxEpisodes: 26, maxItems: 0 } },
    { id: 'qb', type: 'sink.qbittorrent', position: { x: 1680, y: 90 }, config: { urlField: 'torrent_magnet', category: 'anime', savepath: '', paused: false } },
  ],
  edges: [
    { id: 'e1', source: 'idx', sourceHandle: 'items', target: 'diff', targetHandle: 'a' },
    { id: 'e2', source: 'por', sourceHandle: 'items', target: 'diff', targetHandle: 'b' },
    { id: 'e3', source: 'diff', sourceHandle: 'missing', target: 'lim', targetHandle: 'in' },
    { id: 'e4', source: 'lim', sourceHandle: 'items', target: 'st', targetHandle: 'in' },
    { id: 'e5', source: 'st', sourceHandle: 'out', target: 'tpl', targetHandle: 'in' },
    { id: 'e6', source: 'st', sourceHandle: 'unknown', target: 'tpl', targetHandle: 'in' },
    { id: 'e7', source: 'tpl', sourceHandle: 'items', target: 'tor', targetHandle: 'in' },
    { id: 'e8', source: 'tor', sourceHandle: 'found', target: 'qb', targetHandle: 'in' },
  ],
}

// Completed qBittorrent downloads → placed in the media library. Expands each
// torrent into its files, matches back to the catalog for a mal_id, pulls
// metadata (year → import path), probes for a wanted-language subtitle and
// branches: keep the embedded sub (extract) or fetch a replacement, then
// hardlink the file into the library and refresh Jellyfin. Needs the downloads
// + library dirs mounted into the pod (see mcp/README.md / CLAUDE.md).
const LIBRARY_IMPORT_GRAPH: FlowGraph = {
  nodes: [
    { id: 'qb', type: 'source.qbittorrent', position: { x: 0, y: 200 }, config: { category: 'anime', completedOnly: true, pathFrom: '', pathTo: '' } },
    { id: 'exp', type: 'transform.expand-files', position: { x: 260, y: 200 }, config: { pathField: 'content_path', extensions: 'mkv,mp4' } },
    { id: 'match', type: 'enrich.indexer-match', position: { x: 520, y: 200 }, config: { setField: 'mal_id', fromField: 'mal_id', queryField: 'name', matchMode: 'tokens', threshold: 0.6 } },
    { id: 'meta', type: 'enrich.metadata', position: { x: 780, y: 120 }, config: { malField: 'mal_id', writeDb: true, maxItems: 0 } },
    { id: 'probe', type: 'enrich.media-probe', position: { x: 1060, y: 200 }, config: { fileField: 'file_path' } },
    { id: 'cmp', type: 'filter.compare', position: { x: 1320, y: 200 }, config: { field: 'sub_langs', op: 'contains', value: 'eng' } },
    { id: 'ext', type: 'enrich.extract-subs', position: { x: 1580, y: 120 }, config: { fileField: 'file_path', lang: 'eng' } },
    { id: 'fetch', type: 'enrich.fetch-subs', position: { x: 1580, y: 300 }, config: { queryField: 'title_english', episodeField: 'torrent_episode', lang: 'eng' } },
    { id: 'mg', type: 'combine.merge', position: { x: 1860, y: 220 }, config: {} },
    // libraryRoot empty => LIBRARY_DIR env. showField=title_english (set by the
    // metadata node); falls back to the release name for unmatched files.
    { id: 'imp', type: 'sink.library-import', position: { x: 2120, y: 220 }, config: { fileField: 'file_path', libraryRoot: '', showField: 'title_english', method: 'hardlink' } },
    { id: 'scan', type: 'sink.jellyfin-scan', position: { x: 2400, y: 220 }, config: {} },
  ],
  edges: [
    { id: 'e1', source: 'qb', sourceHandle: 'items', target: 'exp', targetHandle: 'in' },
    { id: 'e2', source: 'exp', sourceHandle: 'files', target: 'match', targetHandle: 'in' },
    { id: 'e3', source: 'match', sourceHandle: 'matched', target: 'meta', targetHandle: 'in' },
    // Unmatched files still import (just without our metadata / clean year).
    { id: 'e4', source: 'match', sourceHandle: 'unmatched', target: 'probe', targetHandle: 'in' },
    { id: 'e5', source: 'meta', sourceHandle: 'enriched', target: 'probe', targetHandle: 'in' },
    { id: 'e6', source: 'meta', sourceHandle: 'skipped', target: 'probe', targetHandle: 'in' },
    { id: 'e7', source: 'probe', sourceHandle: 'probed', target: 'cmp', targetHandle: 'in' },
    // Has a wanted-language track → extract it; otherwise fetch a replacement.
    { id: 'e8', source: 'cmp', sourceHandle: 'pass', target: 'ext', targetHandle: 'in' },
    { id: 'e9', source: 'cmp', sourceHandle: 'fail', target: 'fetch', targetHandle: 'in' },
    // Every branch converges on import — never drop a file just because subs failed.
    { id: 'e10', source: 'ext', sourceHandle: 'extracted', target: 'mg', targetHandle: 'in' },
    { id: 'e11', source: 'ext', sourceHandle: 'none', target: 'mg', targetHandle: 'in' },
    { id: 'e12', source: 'fetch', sourceHandle: 'found', target: 'mg', targetHandle: 'in' },
    { id: 'e13', source: 'fetch', sourceHandle: 'missed', target: 'mg', targetHandle: 'in' },
    { id: 'e14', source: 'mg', sourceHandle: 'items', target: 'imp', targetHandle: 'in' },
    { id: 'e15', source: 'imp', sourceHandle: 'imported', target: 'scan', targetHandle: 'in' },
  ],
}

// Seeds are versioned via SQLite's user_version so later releases can add
// flows to existing databases without re-creating deleted ones.
const SEED_VERSION = 3

function seedFlows(instance: ReturnType<typeof getDb>) {
  const insert = instance.prepare('INSERT INTO flows (name, description, graph) VALUES (?, ?, ?)')
  const count = (instance.prepare('SELECT COUNT(*) AS c FROM flows').get() as { c: number }).c
  const version = instance.pragma('user_version', { simple: true }) as number
  if (count === 0 && version < 1) {
    insert.run(
      'Image sourcing',
      'How portal artwork is filled in: Jellyfin first, then the indexer catalog, then Jikan. Mirrors the built-in sync.',
      JSON.stringify(SEED_GRAPH),
    )
  }
  if (version < 2) {
    insert.run(
      'Missing videos',
      'Finds indexer titles with no matching portal item, picks a 1080p dual-audio release (season pack if finished, recent episodes if airing) with live seeders, and queues it in qBittorrent.',
      JSON.stringify(MISSING_VIDEOS_GRAPH),
    )
  }
  if (version < 3) {
    insert.run(
      'Library import',
      'Places completed qBittorrent downloads into the media library: expand to files, match the catalog for metadata, keep or fetch a subtitle, hardlink into the library, refresh Jellyfin. Needs the downloads + library dirs mounted into the pod.',
      JSON.stringify(LIBRARY_IMPORT_GRAPH),
    )
  }
  if (version < SEED_VERSION) instance.pragma(`user_version = ${SEED_VERSION}`)
}

export function listFlows(): FlowSummary[] {
  const rows = db().prepare('SELECT * FROM flows ORDER BY updated_at DESC').all() as FlowRow[]
  return rows.map((r) => {
    let nodeCount = 0
    try {
      nodeCount = (JSON.parse(r.graph) as FlowGraph).nodes.length
    } catch {
      /* corrupt graph JSON — surfaced as 0 nodes */
    }
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      node_count: nodeCount,
      updated_at: r.updated_at,
    }
  })
}

export function getFlow(id: number): FlowRow | undefined {
  return db().prepare('SELECT * FROM flows WHERE id = ?').get(id) as FlowRow | undefined
}

export function createFlow(name: string, description: string | null): FlowRow {
  const empty: FlowGraph = { nodes: [], edges: [] }
  const info = db()
    .prepare('INSERT INTO flows (name, description, graph) VALUES (?, ?, ?)')
    .run(name, description, JSON.stringify(empty))
  return getFlow(Number(info.lastInsertRowid))!
}

export function updateFlow(
  id: number,
  patch: { name?: string; description?: string | null; graph?: FlowGraph },
): FlowRow | undefined {
  const existing = getFlow(id)
  if (!existing) return undefined
  db()
    .prepare(
      `UPDATE flows SET name = ?, description = ?, graph = ?, updated_at = datetime('now') WHERE id = ?`,
    )
    .run(
      patch.name ?? existing.name,
      patch.description === undefined ? existing.description : patch.description,
      patch.graph ? JSON.stringify(patch.graph) : existing.graph,
      id,
    )
  return getFlow(id)
}

export function deleteFlow(id: number): boolean {
  return db().prepare('DELETE FROM flows WHERE id = ?').run(id).changes > 0
}
