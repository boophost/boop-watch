# Sub-flow Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users publish any flow as a reusable custom node with boundary-defined ports, exposed inner config parameters, and live-reference sub-flow execution in parent flows.

**Architecture:** Add `component` JSON metadata on `flows` rows, two boundary node types for interface definition, a `flow.subflow` composite node that recursively calls `runFlow`, and a new `server/flowComponents.ts` module for interface derivation and reference validation. The editor merges static node specs with dynamic component specs for the picker and renders dynamic handles on sub-flow nodes.

**Tech Stack:** Express 5, better-sqlite3, TypeScript ESM (`server/`), React 19 + `@xyflow/react`, existing flow executor/registry patterns.

**Spec:** [`docs/superpowers/specs/2026-07-06-subflow-components-design.md`](../specs/2026-07-06-subflow-components-design.md)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `server/flowComponents.ts` | Create | Derive interfaces, publish validation, reference cycle detection, component specs |
| `server/flowNodes.ts` | Modify | Add `boundary` category, boundary nodes, `flow.subflow` impl |
| `server/flowExecutor.ts` | Modify | Accept dynamic spec resolver in `validateGraph` |
| `server/flowsDb.ts` | Modify | `component` column migration, parse/serialize, list published |
| `server/flowRoutes.ts` | Modify | New endpoints, extended PUT, reference guards |
| `src/lib/flows.ts` | Modify | Types + API helpers |
| `src/pages/manage/FlowEditor.tsx` | Modify | Publish panel, dynamic handles, Custom/Boundary picker |
| `src/pages/manage/Flows.tsx` | Modify | Published badge on flow cards |
| `scripts/verify-components.mjs` | Create | Smoke script for interface derivation + sub-flow run |

No test runner exists in this repo; verification uses `npm run build:all` plus `scripts/verify-components.mjs`.

---

## Phase 1 — Foundation: boundary nodes, DB, APIs

### Task 1: Extend types and add `flowComponents.ts` skeleton

**Files:**
- Create: `server/flowComponents.ts`
- Modify: `server/flowNodes.ts:35-43`
- Modify: `src/lib/flows.ts:21-31`

- [ ] **Step 1: Extend `NodeCategory` on server and client**

In `server/flowNodes.ts`:

```ts
export type NodeCategory = 'source' | 'filter' | 'enrich' | 'combine' | 'sink' | 'boundary'
```

In `src/lib/flows.ts`:

```ts
export type NodeCategory = 'source' | 'filter' | 'enrich' | 'combine' | 'sink' | 'boundary'
```

- [ ] **Step 2: Create `server/flowComponents.ts` with core types**

```ts
import type { FlowGraph } from './flowExecutor.js'
import type { ConfigField, NodePort, NodeSpec } from './flowNodes.js'

export interface ExposedParam {
  nodeId: string
  configKey: string
  label?: string
}

export interface FlowComponentMeta {
  published: boolean
  label: string
  description: string
  category: 'source' | 'filter' | 'enrich' | 'combine' | 'sink'
  exposedParams: ExposedParam[]
}

export interface ComponentInterface {
  flowId: number
  inputs: NodePort[]
  outputs: NodePort[]
  exposedParams: (ExposedParam & Pick<ConfigField, 'kind' | 'options'> & { default?: unknown })[]
}

export function deriveInterface(flowId: number, graph: FlowGraph): ComponentInterface | { error: string } {
  const inputs: NodePort[] = []
  const outputs: NodePort[] = []
  const portIds = new Set<string>()

  for (const node of graph.nodes) {
    if (node.type === 'boundary.input') {
      const portId = String(node.config.portId ?? '').trim()
      const label = String(node.config.label ?? portId)
      if (!portId) return { error: `Boundary input ${node.id} missing portId` }
      if (portIds.has(portId)) return { error: `Duplicate portId: ${portId}` }
      portIds.add(portId)
      inputs.push({ id: portId, label })
    } else if (node.type === 'boundary.output') {
      const portId = String(node.config.portId ?? '').trim()
      const label = String(node.config.label ?? portId)
      if (!portId) return { error: `Boundary output ${node.id} missing portId` }
      if (portIds.has(portId)) return { error: `Duplicate portId: ${portId}` }
      portIds.add(portId)
      outputs.push({ id: portId, label })
    }
  }

  if (inputs.length === 0) return { error: 'Published component needs at least one boundary input' }
  if (outputs.length === 0) return { error: 'Published component needs at least one boundary output' }

  return { flowId, inputs, outputs, exposedParams: [] }
}

export function validatePublish(graph: FlowGraph): string | null {
  const iface = deriveInterface(0, graph)
  if ('error' in iface) return iface.error
  return null
}

export function componentToNodeSpec(
  flowId: number,
  flowName: string,
  meta: FlowComponentMeta,
  iface: ComponentInterface,
): NodeSpec {
  return {
    type: 'flow.subflow',
    label: meta.label || flowName,
    category: meta.category,
    description: meta.description,
    inputs: iface.inputs,
    outputs: iface.outputs,
    config: [
      {
        key: 'flowId',
        label: 'Component flow',
        kind: 'select',
        default: flowId,
        options: [{ value: String(flowId), label: flowName }],
      },
      ...iface.exposedParams.map((p) => ({
        key: `params.${p.nodeId}.${p.configKey}`,
        label: p.label ?? p.configKey,
        kind: p.kind,
        default: p.default as string | number | boolean | undefined,
        options: p.options,
      })),
    ],
  }
}
```

- [ ] **Step 3: Build to verify types compile**

Run: `npm run build:all`  
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add server/flowComponents.ts server/flowNodes.ts src/lib/flows.ts
git commit -m "feat(flows): add component types and interface derivation skeleton"
```

---

### Task 2: Boundary node implementations

**Files:**
- Modify: `server/flowNodes.ts` (append before `IMPLS` array)

- [ ] **Step 1: Add boundary node handlers**

Add to `IMPLS` array in `server/flowNodes.ts`:

```ts
{
  spec: {
    type: 'boundary.input',
    label: 'Input',
    category: 'boundary',
    description: 'External input port for a published component flow.',
    inputs: [],
    outputs: [{ id: 'items', label: 'items' }],
    config: [
      { key: 'portId', label: 'Port id', kind: 'text', default: 'in' },
      { key: 'label', label: 'Label', kind: 'text', default: 'Input' },
    ],
  },
  run: async (inputs, config) => {
    // Identity source: items injected by sub-flow executor land in buffers before run.
    // If wired internally, pass through nothing (empty source).
    return { items: inputs.items ?? [] }
  },
},
{
  spec: {
    type: 'boundary.output',
    label: 'Output',
    category: 'boundary',
    description: 'External output port for a published component flow.',
    inputs: [{ id: 'items', label: 'items' }],
    outputs: [],
    config: [
      { key: 'portId', label: 'Port id', kind: 'text', default: 'out' },
      { key: 'label', label: 'Label', kind: 'text', default: 'Output' },
    ],
  },
  run: async (inputs) => {
    // Terminal collector: sub-flow executor reads this node's inputs after run.
    return {}
  },
},
```

Note: boundary.input `run` returns `{ items: inputs.items ?? [] }` — the sub-flow executor pre-seeds buffers for boundary inputs before calling `runFlow`; internal edges into boundary inputs still work for graphs tested standalone.

- [ ] **Step 2: Add Boundary dot color in editor**

In `src/pages/manage/FlowEditor.tsx` `CATEGORY_DOT`:

```ts
boundary: 'bg-zinc-400',
```

In `CATEGORY_LABEL`:

```ts
boundary: 'Boundary',
```

In `NODE_CATEGORIES`:

```ts
const NODE_CATEGORIES: NodeCategory[] = ['source', 'filter', 'enrich', 'combine', 'sink', 'boundary']
```

Add a **Custom** folder separately in Phase 3 (component specs use their `meta.category`, not a new category enum value).

- [ ] **Step 3: Build**

Run: `npm run build:all`  
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add server/flowNodes.ts src/pages/manage/FlowEditor.tsx
git commit -m "feat(flows): add boundary input/output node types"
```

---

### Task 3: Database migration and component persistence

**Files:**
- Modify: `server/flowsDb.ts`

- [ ] **Step 1: Bump seed version and migrate**

```ts
const SEED_VERSION = 4

// Inside db() init, after CREATE TABLE:
instance.exec(`ALTER TABLE flows ADD COLUMN component TEXT`)
// Wrap in try/catch — column may already exist on re-init
```

Better pattern (idempotent):

```ts
const cols = instance.prepare(`PRAGMA table_info(flows)`).all() as { name: string }[]
if (!cols.some((c) => c.name === 'component')) {
  instance.exec(`ALTER TABLE flows ADD COLUMN component TEXT`)
}
if (version < 4) instance.pragma('user_version = 4')
```

- [ ] **Step 2: Extend `FlowRow` and helpers**

```ts
export interface FlowRow {
  id: number
  name: string
  description: string | null
  graph: string
  component: string | null
  created_at: string
  updated_at: string
}

export function parseComponent(raw: string | null): FlowComponentMeta | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as FlowComponentMeta
  } catch {
    return null
  }
}

export function listPublishedComponents(): { row: FlowRow; graph: FlowGraph; meta: FlowComponentMeta }[] {
  const rows = db().prepare(`SELECT * FROM flows WHERE component IS NOT NULL`).all() as FlowRow[]
  return rows
    .map((row) => {
      const meta = parseComponent(row.component)
      if (!meta?.published) return null
      try {
        return { row, graph: JSON.parse(row.graph) as FlowGraph, meta }
      } catch {
        return null
      }
    })
    .filter(Boolean) as { row: FlowRow; graph: FlowGraph; meta: FlowComponentMeta }[]
}
```

- [ ] **Step 3: Extend `updateFlow`**

```ts
export function updateFlow(
  id: number,
  patch: { name?: string; description?: string | null; graph?: FlowGraph; component?: FlowComponentMeta | null },
): FlowRow | undefined {
  // ...
  component: patch.component === undefined ? existing.component : (patch.component ? JSON.stringify(patch.component) : null),
}
```

- [ ] **Step 4: Build**

Run: `npm run build:all`  
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add server/flowsDb.ts
git commit -m "feat(flows): add component column and published flow queries"
```

---

### Task 4: Component API endpoints

**Files:**
- Modify: `server/flowRoutes.ts`
- Modify: `src/lib/flows.ts`

- [ ] **Step 1: Add routes**

In `server/flowRoutes.ts`:

```ts
import {
  deriveInterface,
  validatePublish,
  componentToNodeSpec,
  type FlowComponentMeta,
} from './flowComponents.js'
import { listPublishedComponents, parseComponent } from './flowsDb.js'

flowRouter.get('/api/flows/components', (_req, res) => {
  const specs = listPublishedComponents().flatMap(({ row, graph, meta }) => {
    const iface = deriveInterface(row.id, graph)
    if ('error' in iface) return []
    // enrich exposedParams from graph + NODE_REGISTRY in Task 5
    return [componentToNodeSpec(row.id, row.name, meta, iface)]
  })
  res.json({ components: specs })
})

flowRouter.get('/api/flows/:id/interface', (req, res) => {
  const id = Number(req.params.id)
  const row = flowsDb.getFlow(id)
  if (!row) return res.status(404).json({ error: 'not found' })
  const graph = JSON.parse(row.graph) as FlowGraph
  const meta = parseComponent(row.component)
  const iface = deriveInterface(id, graph)
  if ('error' in iface) return res.status(400).json({ error: iface.error })
  res.json({ interface: iface, component: meta })
})
```

- [ ] **Step 2: Extend PUT `/api/flows/:id`**

When body includes `component`:

```ts
if (component?.published) {
  const graph = patch.graph ?? JSON.parse(existing.graph)
  const err = validatePublish(graph)
  if (err) return res.status(400).json({ error: err })
}
```

- [ ] **Step 3: Client helpers in `src/lib/flows.ts`**

```ts
export interface FlowComponentMeta { /* mirror server */ }

export interface Flow {
  // ...
  component: FlowComponentMeta | null
}

export const getFlowComponents = () =>
  fetchAuth<{ components: NodeSpec[] }>('/api/flows/components').then((r) => r.components)

export const getFlowInterface = (id: number) =>
  fetchAuth<{ interface: ComponentInterface; component: FlowComponentMeta | null }>(
    `/api/flows/${id}/interface`,
  )
```

- [ ] **Step 4: Build and smoke**

Run: `npm run build:all`  
Run server, `curl -H "Authorization: Bearer …" http://localhost:3001/api/flows/components`  
Expected: `{ "components": [] }`

- [ ] **Step 5: Commit**

```bash
git add server/flowRoutes.ts src/lib/flows.ts
git commit -m "feat(flows): add component and interface API endpoints"
```

---

## Phase 2 — Execution: sub-flow node and validation

### Task 5: Enrich exposed params in `deriveInterface`

**Files:**
- Modify: `server/flowComponents.ts`

- [ ] **Step 1: Add param enrichment**

```ts
import { NODE_REGISTRY } from './flowNodes.js'

export function enrichExposedParams(
  graph: FlowGraph,
  meta: FlowComponentMeta,
): ComponentInterface['exposedParams'] {
  return meta.exposedParams.flatMap((p) => {
    const node = graph.nodes.find((n) => n.id === p.nodeId)
    if (!node) return []
    const spec = NODE_REGISTRY.get(node.type)?.spec
    const field = spec?.config.find((f) => f.key === p.configKey)
    if (!field) return []
    return [{
      ...p,
      label: p.label ?? field.label,
      kind: field.kind,
      default: node.config[p.configKey] ?? field.default,
      options: field.options,
    }]
  })
}

export function deriveInterface(
  flowId: number,
  graph: FlowGraph,
  meta?: FlowComponentMeta | null,
): ComponentInterface | { error: string } {
  // ... existing boundary extraction ...
  return {
    flowId,
    inputs,
    outputs,
    exposedParams: meta ? enrichExposedParams(graph, meta) : [],
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server/flowComponents.ts server/flowRoutes.ts
git commit -m "feat(flows): enrich exposed params from inner node specs"
```

---

### Task 6: Dynamic validation in `flowExecutor.ts`

**Files:**
- Modify: `server/flowExecutor.ts`
- Modify: `server/flowComponents.ts`

- [ ] **Step 1: Add spec resolver parameter**

```ts
export type SpecResolver = (node: FlowNode) => { inputs: { id: string }[]; outputs: { id: string }[] } | null

export function validateGraph(
  graph: FlowGraph,
  resolveSpec?: SpecResolver,
): string | null {
  // ...
  for (const edge of graph.edges) {
    const sourceSpec = resolveSpec?.(source) ?? NODE_REGISTRY.get(source.type)!.spec
    const targetSpec = resolveSpec?.(target) ?? NODE_REGISTRY.get(target.type)!.spec
    if (!sourceSpec || !targetSpec) return `Unknown node type: ${source.type}`
    // use sourceSpec.outputs / targetSpec.inputs
  }
}
```

- [ ] **Step 2: Add reference cycle detection in `flowComponents.ts`**

```ts
export function findSubflowReferences(graph: FlowGraph): number[] {
  return graph.nodes
    .filter((n) => n.type === 'flow.subflow')
    .map((n) => Number(n.config.flowId))
    .filter((id) => Number.isFinite(id))
}

export function detectReferenceCycle(
  rootFlowId: number,
  loadGraph: (id: number) => FlowGraph | null,
): string | null {
  const stack = new Set<number>()
  const visited = new Set<number>()

  function dfs(flowId: number): string | null {
    if (stack.has(flowId)) return `Reference cycle involving flow ${flowId}`
    if (visited.has(flowId)) return null
    visited.add(flowId)
    stack.add(flowId)
    const graph = loadGraph(flowId)
    if (graph) {
      for (const ref of findSubflowReferences(graph)) {
        const err = dfs(ref)
        if (err) return err
      }
    }
    stack.delete(flowId)
    return null
  }

  return dfs(rootFlowId)
}
```

- [ ] **Step 3: Wire resolver in `parseGraph` (`flowRoutes.ts`)**

Build a resolver that, for `flow.subflow` nodes, loads published flow interface via `deriveInterface`.

Also reject self-reference: if `flowId === parentFlowId`, return error.

- [ ] **Step 4: Build**

Run: `npm run build:all`  
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add server/flowExecutor.ts server/flowComponents.ts server/flowRoutes.ts
git commit -m "feat(flows): dynamic sub-flow port validation and reference cycle detection"
```

---

### Task 7: Implement `flow.subflow` executor

**Files:**
- Modify: `server/flowNodes.ts`
- Modify: `server/flowExecutor.ts` (export `runFlow` hooks prefix helper)

- [ ] **Step 1: Add sub-flow node to registry**

```ts
import { runFlow } from './flowExecutor.js'
import { getFlow, parseComponent } from './flowsDb.js'
import { deriveInterface, enrichExposedParams } from './flowComponents.js'

// Inside IMPLS:
{
  spec: {
    type: 'flow.subflow',
    label: 'Sub-flow',
    category: 'combine',
    description: 'Runs a published flow as a composite node.',
    inputs: [{ id: 'in', label: 'in' }],  // placeholder; dynamic at validate time
    outputs: [{ id: 'out', label: 'out' }],
    config: [{ key: 'flowId', label: 'Component flow', kind: 'number' }],
  },
  run: async (inputs, config, ctx) => {
    const flowId = Number(config.flowId)
    if (!Number.isFinite(flowId)) throw new Error('flowId required')

    const row = getFlow(flowId)
    if (!row) throw new Error(`Flow ${flowId} not found`)
    const meta = parseComponent(row.component)
    if (!meta?.published) throw new Error(`Flow ${flowId} is not a published component`)

    const graph = structuredClone(JSON.parse(row.graph) as FlowGraph)

    // Apply exposed param overrides: keys params.nodeId.configKey
    const params = (config.params ?? {}) as Record<string, unknown>
    for (const [key, value] of Object.entries(params)) {
      const dot = key.indexOf('.')
      if (dot === -1) continue
      const nodeId = key.slice(0, dot)
      const configKey = key.slice(dot + 1)
      const node = graph.nodes.find((n) => n.id === nodeId)
      if (node) node.config = { ...node.config, [configKey]: value }
    }

    const iface = deriveInterface(flowId, graph, meta)
    if ('error' in iface) throw new Error(iface.error)

    // Pre-seed boundary input buffers by injecting into a patched graph:
    // Replace boundary.input run inputs by merging parent port items before run.
    // Simplest approach: prepend synthetic edges from a virtual source — instead,
    // use a pre-run buffer injection map passed into a new runFlow option.

    const inner = await runFlowWithInjection(graph, ctx.dryRun, (node) => {
      if (node.type !== 'boundary.input') return null
      const portId = String(node.config.portId ?? '')
      return inputs[portId] ?? []
    })

    if (!inner.ok) throw new Error(inner.error ?? 'Sub-flow failed')

    // Collect boundary outputs
    const outputs: Record<string, FlowItem[]> = {}
    for (const node of graph.nodes) {
      if (node.type !== 'boundary.output') continue
      const portId = String(node.config.portId ?? '')
      const items = inner.finalInputs?.get(node.id) ?? []
      outputs[portId] = items
    }

    ctx.notes.push(`sub-flow ${flowId}: ${inner.durationMs}ms`)
    return outputs
  },
},
```

- [ ] **Step 2: Add `runFlowWithInjection` to `flowExecutor.ts`**

Extend `runFlow` with optional `injectInputs?: (node: FlowNode) => FlowItem[] | null`. When a boundary.input node runs, if injector returns items, use those as its output buffer instead of calling `impl.run`.

Also track `finalInputs: Map<nodeId, FlowItem[]>` — snapshot of gathered inputs per node after the run (for boundary.output collection).

- [ ] **Step 3: Prefix nested hook IDs**

When sub-flow calls `runFlow`, pass hooks:

```ts
onNodeStart: (id) => hooks?.onNodeStart?.(`${parentId}/${id}`),
onNodeDone: (id, report) => hooks?.onNodeDone?.(`${parentId}/${id}`, report),
```

Store `parentId` in `RunContext` (extend `RunContext` with optional `qualifyId?: (id: string) => string`).

- [ ] **Step 4: Create verification script**

`scripts/verify-components.mjs`:

```js
// 1. Create in-memory or temp-db flow with boundary nodes + filter.field pass-through
// 2. Publish it
// 3. Create parent with flow.subflow
// 4. Dry-run and assert counts
```

Run: `node scripts/verify-components.mjs`  
Expected: prints `ok`

- [ ] **Step 5: Build + commit**

```bash
git add server/flowNodes.ts server/flowExecutor.ts scripts/verify-components.mjs
git commit -m "feat(flows): implement flow.subflow composite execution"
```

---

## Phase 3 — Editor UX

### Task 8: Load and merge component specs in editor

**Files:**
- Modify: `src/pages/manage/FlowEditor.tsx`
- Modify: `src/lib/flows.ts`

- [ ] **Step 1: Fetch components on editor load**

```ts
const [components, setComponents] = useState<NodeSpec[]>([])

// in useEffect alongside getNodeTypes:
const [types, flow, comps] = await Promise.all([
  getNodeTypes(),
  getFlow(id),
  getFlowComponents(),
])
setComponents(comps)
```

- [ ] **Step 2: Extend NodePicker with Custom folder**

After built-in categories, if `components.length > 0`:

```tsx
<div key="custom">
  <button type="button" onClick={() => toggleCategory('custom' as NodeCategory)}>
    Custom · {components.length}
  </button>
  {!isCollapsed('custom') && components.map((s) => (
    <button key={`subflow-${s.config.find(f => f.key === 'flowId')?.default}`} onClick={() => addNode(s)}>
      ...
    </button>
  ))}
</div>
```

When adding a component node, set:

```ts
data: {
  specType: 'flow.subflow',
  config: {
    flowId: componentFlowId,
    params: {},
  },
}
```

- [ ] **Step 3: Dynamic handles for sub-flow nodes**

When rendering `FlowNodeView`, if `data.specType === 'flow.subflow'`:

```ts
const flowId = Number(data.config.flowId)
const [iface, setIface] = useState<ComponentInterface | null>(null)
useEffect(() => {
  if (!Number.isFinite(flowId)) return
  void getFlowInterface(flowId).then((r) => setIface(r.interface))
}, [flowId])
// Render handles from iface.inputs / iface.outputs instead of static spec
```

Extract a `useComponentInterface(flowId)` hook to avoid clutter.

- [ ] **Step 4: Build**

Run: `npm run build:all`  
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add src/pages/manage/FlowEditor.tsx src/lib/flows.ts
git commit -m "feat(flows): show published components in editor picker with dynamic ports"
```

---

### Task 9: Publish-as-component panel

**Files:**
- Modify: `src/pages/manage/FlowEditor.tsx`
- Modify: `src/lib/flows.ts` (`saveFlow` accepts `component`)

- [ ] **Step 1: Add publish state to editor**

Load `flow.component` from `getFlow`. Add collapsible **Component** section in config area or header menu:

- Toggle: Publish as component
- Inputs: label, description, category select
- Exposed params: for each non-boundary node with config fields, checkbox per field

- [ ] **Step 2: Save component metadata**

Extend `saveFlow` payload:

```ts
export function saveFlow(id: number, patch: { name?: string; graph?: FlowGraph; component?: FlowComponentMeta | null })
```

On save, include `component` when dirty.

- [ ] **Step 3: Sub-flow config panel**

When selected node is `flow.subflow`:
- Show link `<Link to={/manage/flows/${flowId}}>Open component flow ↗</Link>`
- Render exposed param fields from `getFlowInterface(flowId)`

- [ ] **Step 4: Manual test**

1. Create flow with boundary nodes + one enrich node  
2. Publish with exposed param  
3. Appears in Custom folder  
4. Drop into another flow, set param, dry-run  

- [ ] **Step 5: Commit**

```bash
git add src/pages/manage/FlowEditor.tsx src/lib/flows.ts
git commit -m "feat(flows): publish-as-component panel and sub-flow config UI"
```

---

## Phase 4 — Polish

### Task 10: Reference guards and flow list badges

**Files:**
- Modify: `server/flowComponents.ts`
- Modify: `server/flowRoutes.ts`
- Modify: `src/pages/manage/Flows.tsx`

- [ ] **Step 1: `findReferrers(flowId)` in `flowComponents.ts`**

Scan all flows' graphs for `flow.subflow` nodes with matching `flowId`.

- [ ] **Step 2: Block delete/unpublish when referenced**

```ts
flowRouter.delete('/api/flows/:id', (req, res) => {
  const refs = findReferrers(id)
  if (refs.length > 0) return res.status(409).json({ error: 'flow is referenced', references: refs })
  // ...
})
```

- [ ] **Step 3: Published badge on flow list**

In `Flows.tsx`, extend `FlowSummary` with `published: boolean` from API. Show small **Component** badge when true.

- [ ] **Step 4: Commit**

```bash
git add server/flowComponents.ts server/flowRoutes.ts server/flowsDb.ts src/pages/manage/Flows.tsx src/lib/flows.ts
git commit -m "feat(flows): reference guards and published component badges"
```

---

### Task 11: Nested run reporting

**Files:**
- Modify: `src/pages/manage/FlowEditor.tsx`

- [ ] **Step 1: Parse qualified node IDs in report panel**

When `selected.data.report` exists and node is `flow.subflow`, find reports whose keys start with `${selected.id}/`:

```tsx
const innerReports = Object.entries(report.nodes).filter(([k]) => k.startsWith(`${selected.id}/`))
```

Render in `<details>` under the composite node's last-run section.

- [ ] **Step 2: Live run streaming**

`runFlowStream` already updates by node id — nested IDs like `n1/src` will update independently. No server change needed if hooks prefix correctly.

- [ ] **Step 3: Commit + version bump**

Bump `package.json` version (minor: `2.29.0` — new feature).

```bash
git add src/pages/manage/FlowEditor.tsx package.json
git commit -m "feat(flows): nested sub-flow run reporting in editor"
```

---

### Task 12: Final verification and docs

- [ ] **Step 1: Full build**

Run: `npm run build:all`  
Expected: exit 0

- [ ] **Step 2: Run verification script**

Run: `node scripts/verify-components.mjs`  
Expected: `ok`

- [ ] **Step 3: Push to dev and verify staging**

```bash
git push origin dev
kubectl -n link-apps rollout status deployment/boop-watch-dev --timeout=180s
kubectl -n link-apps exec deploy/boop-watch-dev -- wget -qO- http://localhost:3000/health
```

- [ ] **Step 4: Manual editor checklist**

- [ ] Boundary nodes appear under Boundary folder  
- [ ] Publish flow → appears in Custom folder  
- [ ] Sub-flow node shows dynamic ports  
- [ ] Exposed param editable on parent instance  
- [ ] Dry run succeeds; inner steps visible  
- [ ] Cannot delete published flow while referenced  

---

## Spec Coverage Checklist

| Spec requirement | Task |
|------------------|------|
| Publish any flow as component | Task 3, 4, 9 |
| Custom picker metadata | Task 4, 8, 9 |
| Boundary nodes | Task 2 |
| Exposed inner config params | Task 5, 7, 9 |
| Live reference execution | Task 7 |
| Nested reporting | Task 11 |
| Reference cycle detection | Task 6 |
| Delete/unpublish guards | Task 10 |
| API endpoints | Task 4 |
| Dynamic port validation | Task 6 |
| Custom + Boundary picker folders | Task 2, 8 |

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-06-subflow-components.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration  
2. **Inline Execution** — implement tasks in this session with checkpoints

Which approach?
