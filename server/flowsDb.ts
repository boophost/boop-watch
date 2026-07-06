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

// Completed qBittorrent downloads → placed in the media library, and kept at the
// best available quality. Expands each torrent into its files, matches back to
// the catalog for a mal_id, pulls metadata (year → import path), probes each
// file's audio/subtitle tracks, then:
//   • picks the best release per episode (dual-audio beats sub-only) so a later
//     upgrade download replaces the old file instead of colliding with it;
//   • for shows whose best copy is still sub-only, searches for a dual-audio
//     release and queues it — next run it downloads, imports over the old file,
//     and the superseded torrent is deleted (files and all);
//   • keeps or fetches a wanted-language subtitle, hardlinks the winner into the
//     library, and refreshes Jellyfin.
// Run on a schedule: each pass both imports new downloads and hunts upgrades,
// settling once every show is dual-audio. Needs the downloads + library dirs
// mounted into the pod (see mcp/README.md / CLAUDE.md).
const LIBRARY_IMPORT_GRAPH: FlowGraph = {
  nodes: [
    { id: 'qb', type: 'source.qbittorrent', position: { x: 0, y: 300 }, config: { category: 'anime', completedOnly: true, pathFrom: '', pathTo: '' } },
    { id: 'exp', type: 'transform.expand-files', position: { x: 260, y: 300 }, config: { pathField: 'content_path', extensions: 'mkv,mp4' } },
    { id: 'match', type: 'enrich.indexer-match', position: { x: 520, y: 300 }, config: { setField: 'mal_id', fromField: 'mal_id', queryField: 'name', matchMode: 'tokens', threshold: 0.6 } },
    { id: 'meta', type: 'enrich.metadata', position: { x: 780, y: 220 }, config: { malField: 'mal_id', writeDb: true, maxItems: 0 } },
    { id: 'probe', type: 'enrich.media-probe', position: { x: 1040, y: 300 }, config: { fileField: 'file_path' } },
    // Split identified files (upgradable) from unmatched ones (import as-is).
    { id: 'hasId', type: 'filter.field', position: { x: 1300, y: 300 }, config: { field: 'mal_id', mode: 'not-empty', value: '' } },
    // Tag each file's audio quality: 2 = has an English dub (dual audio), 1 = sub-only.
    { id: 'audioCmp', type: 'filter.compare', position: { x: 1560, y: 220 }, config: { field: 'audio_langs', op: 'contains', value: 'eng' } },
    { id: 'dualTag', type: 'transform.template', position: { x: 1820, y: 140 }, config: { field: 'audio_score', template: '2' } },
    { id: 'subTag', type: 'transform.template', position: { x: 1820, y: 300 }, config: { field: 'audio_score', template: '1' } },
    { id: 'scoreMg', type: 'combine.merge', position: { x: 2080, y: 220 }, config: {} },
    { id: 'keyTpl', type: 'transform.template', position: { x: 2340, y: 220 }, config: { field: 'group_key', template: '{mal_id}|{torrent_episode}' } },
    // Best release per episode. Losers ("rest") are candidates for deletion.
    { id: 'pick', type: 'combine.group-pick', position: { x: 2600, y: 220 }, config: { groupField: 'group_key', sortField: 'audio_score', direction: 'desc', perGroup: 1 } },
    // Only delete a torrent none of whose episodes we're keeping — guards against
    // wiping a season pack that still covers episodes the winner doesn't.
    { id: 'safeDel', type: 'combine.diff', position: { x: 2860, y: 480 }, config: { fieldA: 'torrent_hash', fieldB: 'torrent_hash', fieldB2: '' } },
    { id: 'delDed', type: 'filter.dedupe', position: { x: 3120, y: 480 }, config: { field: 'torrent_hash' } },
    { id: 'del', type: 'sink.qbittorrent-delete', position: { x: 3380, y: 480 }, config: { hashField: 'torrent_hash', deleteFiles: true } },
    // Upgrade hunt: shows whose kept copy is still sub-only → find dual audio.
    { id: 'subOnly', type: 'filter.compare', position: { x: 2860, y: 680 }, config: { field: 'audio_score', op: 'eq', value: '1' } },
    { id: 'upDed', type: 'filter.dedupe', position: { x: 3120, y: 680 }, config: { field: 'mal_id' } },
    { id: 'status', type: 'enrich.anime-status', position: { x: 3380, y: 680 }, config: { malField: 'mal_id', maxItems: 0 } },
    { id: 'upTpl', type: 'transform.template', position: { x: 3640, y: 680 }, config: { field: 'torrent_query', template: '{title_english} 1080p' } },
    { id: 'search', type: 'enrich.torrent-search', position: { x: 3900, y: 680 }, config: { provider: 'animetosho', queryField: 'torrent_query', mode: 'auto', resolution: '1080p', requireResolution: false, preferDualAudio: true, requireDualAudio: true, minSeeders: 1, minTitleMatch: 0.4, maxEpisodes: 26, maxItems: 0 } },
    { id: 'upQb', type: 'sink.qbittorrent', position: { x: 4160, y: 680 }, config: { urlField: 'torrent_magnet', category: 'anime', savepath: '', paused: false } },
    // Import path (best-per-episode winners + unmatched files).
    { id: 'preSub', type: 'combine.merge', position: { x: 2860, y: 220 }, config: {} },
    { id: 'cmp', type: 'filter.compare', position: { x: 3120, y: 220 }, config: { field: 'sub_langs', op: 'contains', value: 'eng' } },
    { id: 'ext', type: 'enrich.extract-subs', position: { x: 3380, y: 140 }, config: { fileField: 'file_path', lang: 'eng' } },
    { id: 'fetch', type: 'enrich.fetch-subs', position: { x: 3380, y: 300 }, config: { queryField: 'title_english', episodeField: 'torrent_episode', lang: 'eng' } },
    { id: 'mg', type: 'combine.merge', position: { x: 3640, y: 220 }, config: {} },
    // overwrite=true so a dual-audio upgrade replaces the old sub-only file; the
    // sink skips re-placing an unchanged file so scheduled re-runs don't churn.
    { id: 'imp', type: 'sink.library-import', position: { x: 3900, y: 220 }, config: { fileField: 'file_path', libraryRoot: '', showField: 'title_english', method: 'hardlink', overwrite: true } },
    { id: 'scan', type: 'sink.jellyfin-scan', position: { x: 4160, y: 220 }, config: {} },
    { id: 'coll', type: 'sink.jellyfin-collection', position: { x: 4420, y: 220 }, config: { nameField: 'title_english', itemType: 'Series', waitSeconds: 120 } },
  ],
  edges: [
    { id: 'e1', source: 'qb', sourceHandle: 'items', target: 'exp', targetHandle: 'in' },
    { id: 'e2', source: 'exp', sourceHandle: 'files', target: 'match', targetHandle: 'in' },
    { id: 'e3', source: 'match', sourceHandle: 'matched', target: 'meta', targetHandle: 'in' },
    // Unmatched files still import (just without our metadata / clean year).
    { id: 'e4', source: 'match', sourceHandle: 'unmatched', target: 'probe', targetHandle: 'in' },
    { id: 'e5', source: 'meta', sourceHandle: 'enriched', target: 'probe', targetHandle: 'in' },
    { id: 'e6', source: 'meta', sourceHandle: 'skipped', target: 'probe', targetHandle: 'in' },
    { id: 'e7', source: 'probe', sourceHandle: 'probed', target: 'hasId', targetHandle: 'in' },
    // Identified files go through quality scoring; unmatched ones import as-is.
    { id: 'e8', source: 'hasId', sourceHandle: 'pass', target: 'audioCmp', targetHandle: 'in' },
    { id: 'e9', source: 'hasId', sourceHandle: 'fail', target: 'preSub', targetHandle: 'in' },
    { id: 'e10', source: 'audioCmp', sourceHandle: 'pass', target: 'dualTag', targetHandle: 'in' },
    { id: 'e11', source: 'audioCmp', sourceHandle: 'fail', target: 'subTag', targetHandle: 'in' },
    { id: 'e12', source: 'dualTag', sourceHandle: 'items', target: 'scoreMg', targetHandle: 'in' },
    { id: 'e13', source: 'subTag', sourceHandle: 'items', target: 'scoreMg', targetHandle: 'in' },
    { id: 'e14', source: 'scoreMg', sourceHandle: 'items', target: 'keyTpl', targetHandle: 'in' },
    { id: 'e15', source: 'keyTpl', sourceHandle: 'items', target: 'pick', targetHandle: 'in' },
    // Winner per episode → import; also feeds the "keep" side of the safe-delete
    // diff and the upgrade hunt.
    { id: 'e16', source: 'pick', sourceHandle: 'picked', target: 'preSub', targetHandle: 'in' },
    { id: 'e17', source: 'pick', sourceHandle: 'picked', target: 'safeDel', targetHandle: 'b' },
    { id: 'e18', source: 'pick', sourceHandle: 'picked', target: 'subOnly', targetHandle: 'in' },
    // Superseded losers whose torrent keeps no winning episode → delete.
    { id: 'e19', source: 'pick', sourceHandle: 'rest', target: 'safeDel', targetHandle: 'a' },
    { id: 'e20', source: 'safeDel', sourceHandle: 'missing', target: 'delDed', targetHandle: 'in' },
    { id: 'e21', source: 'delDed', sourceHandle: 'items', target: 'del', targetHandle: 'in' },
    // Upgrade hunt: one search per still-sub-only show → queue the dual release.
    { id: 'e22', source: 'subOnly', sourceHandle: 'pass', target: 'upDed', targetHandle: 'in' },
    { id: 'e23', source: 'upDed', sourceHandle: 'items', target: 'status', targetHandle: 'in' },
    { id: 'e24', source: 'status', sourceHandle: 'out', target: 'upTpl', targetHandle: 'in' },
    { id: 'e25', source: 'status', sourceHandle: 'unknown', target: 'upTpl', targetHandle: 'in' },
    { id: 'e26', source: 'upTpl', sourceHandle: 'items', target: 'search', targetHandle: 'in' },
    { id: 'e27', source: 'search', sourceHandle: 'found', target: 'upQb', targetHandle: 'in' },
    // Subtitle handling on the import stream: keep an embedded track or fetch one.
    { id: 'e28', source: 'preSub', sourceHandle: 'items', target: 'cmp', targetHandle: 'in' },
    { id: 'e29', source: 'cmp', sourceHandle: 'pass', target: 'ext', targetHandle: 'in' },
    { id: 'e30', source: 'cmp', sourceHandle: 'fail', target: 'fetch', targetHandle: 'in' },
    // Every branch converges on import — never drop a file just because subs failed.
    { id: 'e31', source: 'ext', sourceHandle: 'extracted', target: 'mg', targetHandle: 'in' },
    { id: 'e32', source: 'ext', sourceHandle: 'none', target: 'mg', targetHandle: 'in' },
    { id: 'e33', source: 'fetch', sourceHandle: 'found', target: 'mg', targetHandle: 'in' },
    { id: 'e34', source: 'fetch', sourceHandle: 'missed', target: 'mg', targetHandle: 'in' },
    { id: 'e35', source: 'mg', sourceHandle: 'items', target: 'imp', targetHandle: 'in' },
    { id: 'e36', source: 'imp', sourceHandle: 'imported', target: 'scan', targetHandle: 'in' },
    { id: 'e37', source: 'scan', sourceHandle: 'items', target: 'coll', targetHandle: 'in' },
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
      'Places completed qBittorrent downloads into the media library and keeps them at the best quality: expand to files, pick the best release per episode (dual-audio over sub-only), hunt a dual-audio upgrade for sub-only shows, keep or fetch a subtitle, hardlink into the library (replacing superseded files and deleting their torrents), refresh Jellyfin. Needs the downloads + library dirs mounted into the pod.',
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
