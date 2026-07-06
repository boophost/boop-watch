# Sub-flow Components Design Spec

**Date:** 2026-07-06  
**Status:** Approved  
**Goal:** Let any flow be published as a reusable custom node (component) with boundary-defined ports, exposed parameters, and custom picker metadata — making the flow system composable and user-customizable.

---

## Background

boop-watch flows are flat DAGs stored as JSON in SQLite. Nodes are registered in `server/flowNodes.ts`; the executor in `server/flowExecutor.ts` walks nodes in topological order, passing loose JSON items between named ports. There is no nesting, flow references, or user-defined node types today.

This feature adds **live-reference sub-flow components**: a parent flow embeds another published flow via a `flow.subflow` node. The embedded flow's external interface is defined visually with **boundary nodes** on its canvas.

---

## Requirements

### Functional

1. **Publish any flow as a component** — same DB row, flagged with metadata; remains editable as a normal flow.
2. **Custom node picker entry** — published components appear in a **Custom** folder with user-defined label, description, and category tint.
3. **Boundary-defined interface** — `boundary.input` and `boundary.output` nodes declare external ports.
4. **Parameterized placement** — when publishing, author selects inner node config fields to expose; parent instances set values per placement.
5. **Live reference execution** — edits to the component flow propagate to all parent uses without re-saving parents.
6. **Nested reporting** — inner node progress visible under the composite node (qualified IDs).

### Non-functional

- Sub-flow execution runs inside the parent run (same flow lock, no nested scheduler fires).
- Reference cycles (A → B → A) rejected at save/validate time.
- Unpublish/delete blocked or warned when other flows reference the component.
- No client hardcoding of component knowledge — specs derived server-side.

---

## Data Model

### `flows.component` column (JSON, nullable)

```ts
interface FlowComponentMeta {
  published: boolean
  label: string              // picker display name; defaults to flow.name
  description: string        // picker description; defaults to flow.description ?? ''
  category: NodeCategory     // picker folder tint (source|filter|enrich|combine|sink)
  exposedParams: ExposedParam[]
}

interface ExposedParam {
  nodeId: string             // inner node id
  configKey: string          // inner config field key
  label?: string             // override label on parent instance
}
```

Migration: SQLite `user_version` bump (4). `ALTER TABLE flows ADD COLUMN component TEXT` with `NULL` default for existing rows.

### Parent `flow.subflow` node config

```ts
{
  flowId: number
  params: Record<string, unknown>  // keys: "${nodeId}.${configKey}"
}
```

### Derived component interface (computed, not stored)

```ts
interface ComponentInterface {
  flowId: number
  inputs: NodePort[]   // from boundary.input nodes, portId → handle id
  outputs: NodePort[]  // from boundary.output nodes
  exposedParams: (ExposedParam & { kind: ConfigField['kind']; default?: unknown; options? })[]
}
```

---

## Boundary Nodes

New category: **`boundary`**.

| Type | Inputs | Outputs | Config |
|------|--------|---------|--------|
| `boundary.input` | — | `items` | `portId` (string, required, unique per flow), `label` (string, display) |
| `boundary.output` | `items` | — | `portId` (string, required, unique per flow), `label` (string, display) |

### Semantics

- **Input boundary:** emits `items` to downstream nodes. At sub-flow run time, items come from the parent's wired input port matching `portId`.
- **Output boundary:** accepts `items` from upstream. At sub-flow run time, collected items become the parent's output port matching `portId`.
- Boundary nodes are **pass-through markers** during inner execution: they behave like identity nodes (input → output unchanged) so the inner graph topology stays valid.
- Publishing requires ≥1 input boundary and ≥1 output boundary with unique `portId` values across both types.

### Category extension

Extend `NodeCategory` in `server/flowNodes.ts` and `src/lib/flows.ts`:

```ts
type NodeCategory = 'source' | 'filter' | 'enrich' | 'combine' | 'sink' | 'boundary'
```

Editor dot color for `boundary`: `bg-zinc-400`.

---

## Composite Node: `flow.subflow`

Static registry entry in `flowNodes.ts`. **Ports are dynamic** — resolved from the referenced flow's component interface at validate/render time.

Static spec placeholder (overridden client-side):

```ts
{
  type: 'flow.subflow',
  label: 'Sub-flow',
  category: 'combine',
  description: 'Runs a published flow as a composite node.',
  inputs: [],   // filled dynamically
  outputs: [],
  config: [
    { key: 'flowId', label: 'Component flow', kind: 'select' /* populated client-side */ },
    // exposed param fields appended dynamically per selected flow
  ],
}
```

### Execution algorithm

1. Load referenced flow; error if missing or not published.
2. Clone inner graph; apply `params` overrides to inner node configs.
3. Inject parent inputs into boundary input nodes' output buffers (by `portId`).
4. Run inner graph via `runFlow(innerGraph, dryRun, nestedHooks)`.
5. Read boundary output node inputs as parent outputs.
6. Parent node status: `error` if any inner node errored; `ok` otherwise. Roll up inner counts/samples with prefixed keys.

### Nested hooks

Inner node IDs reported as `${parentNodeId}/${innerNodeId}`. Parent `onNodeStart`/`onNodeDone` for the composite node fire once; inner events forwarded through nested hooks for live streaming.

---

## Validation

Extend `validateGraph(graph, opts?)` with optional resolver context:

| Check | When |
|-------|------|
| Unknown node types | always |
| Handle existence | always; for `flow.subflow`, use derived interface not static spec |
| Edge cycles | always (topo sort) |
| Reference cycles | when graph contains `flow.subflow` — DFS on flowId graph |
| Publish rules | when saving `component.published = true` |
| Self-reference | parent flow cannot embed itself |

### Publish validation rules

- ≥1 `boundary.input`, ≥1 `boundary.output`
- Unique `portId` across all boundary nodes
- Each boundary input has ≥1 outgoing edge; each boundary output has ≥1 incoming edge (connected to real pipeline)
- Inner graph validates with standard rules (boundary nodes included)
- No `flow.subflow` referencing the same flow id (direct self-reference)

### Reference integrity

- `GET /api/flows/:id/references` — list parent flows referencing this flowId
- `DELETE` and unpublish: return 409 if references exist (unless `force` query for delete)

---

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/flows/node-types` | Built-in specs only (unchanged) |
| GET | `/api/flows/components` | Published flows as dynamic `NodeSpec[]` |
| GET | `/api/flows/:id/interface` | Derived ports + exposed params for one flow |
| GET | `/api/flows/:id/references` | Flows that embed this flow as sub-flow |
| PUT | `/api/flows/:id` | Accept optional `component`; validate publish rules |

### Component spec shape (for picker)

```ts
{
  type: 'flow.subflow',
  label: component.label,
  description: component.description,
  category: component.category,
  inputs: derived.inputs,
  outputs: derived.outputs,
  config: [
    { key: 'flowId', kind: 'select', default: flowId, options: [{ value: String(flowId), label: flow.name }] },
    ...exposedParamFields
  ],
  componentFlowId: flowId  // client-only hint for dynamic resolution
}
```

The client merges built-in node types + component specs for the picker. Component entries use `type: 'flow.subflow'` with distinct `componentFlowId` for deduplication in the picker (display key: `flow.subflow:${flowId}`).

---

## Editor UX

### Flow list / publish panel

In `FlowEditor` header or a side panel:

- Toggle: **Publish as component**
- Fields: label, description, category (select)
- **Expose parameters:** checklist of inner nodes' config fields (grouped by node label)
- Badge on flow list card when published

### Node picker

Folders: Source | Filter | Enrich | Combine | Sink | **Boundary** | **Custom**

- Boundary: `boundary.input`, `boundary.output`
- Custom: one entry per published component (using component metadata)

### Sub-flow node on canvas

- When `specType === 'flow.subflow'`: fetch interface for `config.flowId`, render dynamic handles
- Config panel: flow selector (if generic sub-flow placed from built-in picker) + exposed param fields
- Link: **Open component flow ↗** → `/manage/flows/:flowId`

### Run report

Composite node shows rollup status. Expandable `<details>` lists inner node reports (qualified IDs). Reuse existing report panel patterns.

---

## Phased Delivery

| Phase | Deliverable |
|-------|-------------|
| **1** | DB migration, boundary nodes, component metadata CRUD, publish validation, `/components` + `/interface` APIs |
| **2** | `flow.subflow` executor, extended validation, reference cycle detection |
| **3** | Editor: Custom/Boundary picker folders, dynamic ports, publish UI, param exposure |
| **4** | Nested run reporting, reference guards on delete/unpublish, flow list badges |

Each phase ships working, testable software.

---

## Out of Scope (v1)

- Version pinning / snapshots of components
- Dedicated parameter schema layer (v2 — inner config exposure is sufficient for now)
- React Flow group/subgraph visual collapse on parent canvas
- Scheduling sub-flows independently
- External plugin / script nodes

---

## Key Files

| File | Role |
|------|------|
| `server/flowComponents.ts` | **New** — interface derivation, publish validation, reference graph |
| `server/flowNodes.ts` | Boundary nodes, `flow.subflow` handler |
| `server/flowExecutor.ts` | Extended validation with dynamic specs |
| `server/flowsDb.ts` | Migration, component column, list published |
| `server/flowRoutes.ts` | New endpoints, extended PUT |
| `src/lib/flows.ts` | Types, API helpers |
| `src/pages/manage/FlowEditor.tsx` | Publish UI, dynamic handles, picker |
| `src/pages/manage/Flows.tsx` | Published badge |

---

## Example

**Component flow "Fetch metadata"** (published):

```
[boundary.input portId=in] → [enrich.metadata] → [boundary.output portId=out]
```

Exposed param: `enrich.metadata.maxItems`

**Parent flow:**

```
[source.indexer] → [flow.subflow flowId=5 params={"enrich.metadata.maxItems": 10}] → [sink.portal-upsert]
```

Parent edge: source `items` → sub-flow `in`; sub-flow `out` → sink `in`.
