#!/usr/bin/env node
// Smoke test for sub-flow composite execution (Task 7): builds a tiny
// published component (boundary.input -> filter.limit -> boundary.output),
// then drives the `flow.subflow` node implementation directly against it and
// checks the round trip — items injected on the parent's input port come back
// out capped by the exposed `count` param, honoring both the component's own
// default and a param override from the embedding node's config.
//
// Runs against the compiled server (needs `npm run build:server` /
// `npm run build:all` first) against a throwaway sqlite db, so it's safe to
// run repeatedly without touching real data.
//
//   node scripts/verify-components.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distServer = path.join(__dirname, '..', 'dist-server')

if (!fs.existsSync(distServer)) {
  console.error(`dist-server not found at ${distServer} — run "npm run build:server" first.`)
  process.exit(1)
}

// Must happen before the dynamic imports below load db.ts's module-scope
// `dataDir` — a fresh, throwaway sqlite db per run.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boop-watch-verify-'))
process.env.DATA_DIR = tmpDir

let failures = 0
function assert(cond, message) {
  if (!cond) {
    failures++
    console.error(`FAIL: ${message}`)
  }
}

async function main() {
  const { createFlow, updateFlow } = await import(path.join(distServer, 'flowsDb.js'))
  const { deriveInterface, validatePublish } = await import(path.join(distServer, 'flowComponents.js'))
  const { NODE_REGISTRY } = await import(path.join(distServer, 'flowNodes.js'))

  // --- Build + publish a tiny component: in -> limit(count) -> out ---------
  const componentGraph = {
    nodes: [
      { id: 'b_in', type: 'boundary.input', position: { x: 0, y: 0 }, config: { portId: 'in', label: 'Input' } },
      { id: 'lim', type: 'filter.limit', position: { x: 100, y: 0 }, config: { count: 2 } },
      { id: 'b_out', type: 'boundary.output', position: { x: 200, y: 0 }, config: { portId: 'out', label: 'Output' } },
    ],
    edges: [
      { id: 'e1', source: 'b_in', sourceHandle: 'items', target: 'lim', targetHandle: 'in' },
      { id: 'e2', source: 'lim', sourceHandle: 'items', target: 'b_out', targetHandle: 'items' },
    ],
  }

  const publishErr = validatePublish(componentGraph)
  assert(publishErr === null, `validatePublish rejected a valid graph: ${publishErr}`)

  const meta = {
    published: true,
    label: 'Test limiter',
    description: 'smoke-test component',
    category: 'filter',
    exposedParams: [{ nodeId: 'lim', configKey: 'count', label: 'Max items' }],
  }

  const created = createFlow('verify-component', 'smoke test component')
  updateFlow(created.id, { graph: componentGraph, component: meta })

  const iface = deriveInterface(created.id, componentGraph, meta)
  assert(!('error' in iface), `deriveInterface failed: ${iface.error}`)
  assert(iface.inputs?.length === 1 && iface.inputs[0].id === 'in', 'expected one input port "in"')
  assert(iface.outputs?.length === 1 && iface.outputs[0].id === 'out', 'expected one output port "out"')
  assert(
    iface.exposedParams?.length === 1 && iface.exposedParams[0].configKey === 'count',
    'expected one exposed param "count"',
  )

  // --- Drive flow.subflow directly (unit-level, bypassing the outer graph's
  // own validateGraph — the parent-graph edge/port validation against a
  // dynamically-shaped component interface is a separate, later task) -------
  const subflow = NODE_REGISTRY.get('flow.subflow')
  assert(!!subflow, 'flow.subflow missing from NODE_REGISTRY')

  const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]

  const defaultCtx = { dryRun: true, notes: [] }
  const defaultRun = await subflow.run({ in: items }, { flowId: created.id }, defaultCtx)
  assert(Array.isArray(defaultRun.out), 'expected an "out" port in the subflow output')
  assert(defaultRun.out?.length === 2, `expected 2 items with the component's default count, got ${defaultRun.out?.length}`)
  assert(defaultCtx.notes.some((n) => n.includes('sub-flow')), 'expected a sub-flow timing note')

  const overrideCtx = { dryRun: true, notes: [] }
  const overrideRun = await subflow.run(
    { in: items },
    { flowId: created.id, 'params.lim.count': 3 },
    overrideCtx,
  )
  assert(overrideRun.out?.length === 3, `expected 3 items with a count override, got ${overrideRun.out?.length}`)

  // Unpublished flows are rejected up front.
  const draft = createFlow('verify-draft', null)
  let threwForDraft = false
  try {
    await subflow.run({ in: items }, { flowId: draft.id }, { dryRun: true, notes: [] })
  } catch {
    threwForDraft = true
  }
  assert(threwForDraft, 'expected flow.subflow to reject an unpublished flow')

  // Missing flows are rejected up front.
  let threwForMissing = false
  try {
    await subflow.run({ in: items }, { flowId: 999999 }, { dryRun: true, notes: [] })
  } catch {
    threwForMissing = true
  }
  assert(threwForMissing, 'expected flow.subflow to reject a missing flow id')
}

main()
  .then(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (failures > 0) {
      console.error(`${failures} check(s) failed`)
      process.exit(1)
    }
    console.log('ok')
  })
  .catch((e) => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    console.error(e)
    process.exit(1)
  })
