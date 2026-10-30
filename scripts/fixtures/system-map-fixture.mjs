// Loads system-map-prod.json (compact: only what src/lib/systemMap.ts reads)
// back into FlowMapEntry / FlowSchedule shapes, padding each graph to its real
// node count so card summaries match prod.
import fs from 'node:fs'

export function loadSystemMapFixture() {
  const raw = JSON.parse(fs.readFileSync(new URL('./system-map-prod.json', import.meta.url), 'utf8'))
  const flows = raw.flows.map((f) => {
    const nodes = f.graph.nodes.map((n, i) => ({ id: `n${i}`, type: n.t, position: { x: 0, y: 0 }, config: n.c }))
    while (nodes.length < f.n)
      nodes.push({ id: `pad${nodes.length}`, type: 'transform.template', position: { x: 0, y: 0 }, config: {} })
    return { id: f.id, name: f.name, description: null, published: f.published, updated_at: '', graph: { nodes, edges: [] } }
  })
  const schedules = raw.schedules.map((s) => ({
    ...s, flow_name: null, name: null, next_run: null, last_run: null, last_run_id: null,
    last_run_ok: null, created_at: '', updated_at: '',
  }))
  return { flows, schedules }
}
