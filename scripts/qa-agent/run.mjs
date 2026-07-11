#!/usr/bin/env node
/**
 * Autonomous QA agent for a feature PR's preview environment.
 *
 *   node scripts/qa-agent/run.mjs <prNumber> [--dry-run]
 *
 * Reads the PR's `## Test plan`, drives each item against the preview env
 * (`BASE_URL`) with a minted admin token, and — for each item the agent verifies
 * — ticks `[x]` on the feature PR and posts an evidence comment. Passed ticks
 * propagate into the dev→main promotion PR automatically (update-promotion-pr.mjs
 * seeds a promotion checkbox as checked when the feature PR's line is `[x]`).
 * The agent NEVER merges or promotes.
 *
 * Talks to GitHub over the REST API (fetch) — no `gh` needed. Env:
 *   GITHUB_REPOSITORY  owner/repo (Actions sets this; or QA_REPO locally)
 *   GITHUB_TOKEN       PR read + body/comment write (or GH_TOKEN)
 *   BASE_URL           preview root, e.g. http://pr-42-watch.boopurno.es
 *   JWT_SECRET         mints the admin token (server jwt.verify fallback)
 *   QA_ADMIN_EMAIL     admin email, must be in the preview's ADMIN_EMAILS
 *                      (default ethanwhi@gmail.com)
 *   QA_PLAYWRIGHT=1    allow the Playwright MCP for UI checks (optional)
 *   CLAUDE_CODE_OAUTH_TOKEN  subscription auth for the `claude` CLI (from
 *                      `claude setup-token`); or ANTHROPIC_API_KEY for API
 *                      billing. Not needed for --dry-run.
 *   QA_MODEL           agent model (default claude-haiku-4-5)
 *
 * `--dry-run` skips the agent (marks every item pass) to exercise the
 * parse → tick → comment pipeline without the API or a live preview.
 */

import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHECKBOX_RE } from '../lib/promotion-checklist.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLAN_HEADING = '## test plan'
const BODY_MARKER = '<!-- qa-agent -->'
const REPO = process.env.GITHUB_REPOSITORY || process.env.QA_REPO
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN

// ---- GitHub REST ------------------------------------------------------------

async function ghApi(method, path, body) {
  if (!REPO || !TOKEN) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required')
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json()
}

// ---- test-plan parsing ------------------------------------------------------

// Ordered checkbox items under the `## Test plan` heading, with their line index
// so the same list drives both the agent prompt and the tick-back.
export function testPlanItems(body) {
  const lines = (body ?? '').split(/\r?\n/)
  const items = []
  let inSection = false
  lines.forEach((line, i) => {
    if (/^##\s/.test(line)) {
      inSection = line.trim().toLowerCase() === PLAN_HEADING
      return
    }
    if (!inSection) return
    const m = line.match(CHECKBOX_RE)
    if (m) items.push({ text: m[2].trim(), line: i, checked: m[1].trim() !== '' })
  })
  return { lines, items }
}

export function tickPassed(lines, items, passedIdx) {
  const passed = new Set(passedIdx)
  const out = [...lines]
  items.forEach((item, i) => {
    if (passed.has(i)) out[item.line] = out[item.line].replace(/\[[ xX]\]/, '[x]')
  })
  return out.join('\n')
}

// ---- agent ------------------------------------------------------------------

// Minimal HS256 JWT — matches what jsonwebtoken emits, so the server's
// jwt.verify(token, JWT_SECRET) fallback (server/index.ts) accepts it. Keeps this
// script dependency-free (no node_modules install in CI).
function mintToken() {
  const secret = process.env.JWT_SECRET
  const email = process.env.QA_ADMIN_EMAIL || 'ethanwhi@gmail.com'
  if (!secret) throw new Error('JWT_SECRET is required to mint the admin token')
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const payload = b64({ email, username: email, iat: now, exp: now + 2 * 3600 })
  const sig = createHmac('sha256', secret).update(`${head}.${payload}`).digest('base64url')
  return `${head}.${payload}.${sig}`
}

function buildPrompt({ baseUrl, token, prTitle, changedFiles, items }) {
  const template = readFileSync(join(HERE, 'prompt.md'), 'utf8')
  const playwrightNote = process.env.QA_PLAYWRIGHT
    ? 'The Playwright MCP (`mcp__playwright__*`) is available for UI checks that an API cannot prove.'
    : 'No browser is available — verify via HTTP; mark genuinely UI-only items `skip`.'
  return template
    .replaceAll('{{BASE_URL}}', baseUrl)
    .replaceAll('{{TOKEN}}', token)
    .replaceAll('{{PR_TITLE}}', prTitle)
    .replaceAll('{{CHANGED_FILES}}', changedFiles || '(none listed)')
    .replaceAll('{{PLAYWRIGHT_NOTE}}', playwrightNote)
    .replaceAll('{{ITEMS}}', items.map((it, i) => `${i}. ${it.text}`).join('\n'))
}

// Run the claude CLI in headless JSON mode and pull the verdict block out of the
// assistant's final message. Fast model + budget/time caps keep a QA pass cheap
// and bounded (a QA agent mostly curls endpoints — it doesn't need Opus).
function runAgent(prompt) {
  const model = process.env.QA_MODEL || 'claude-haiku-4-5'
  const timeoutMs = Number(process.env.QA_TIMEOUT_MS || 8 * 60_000)

  const allowed = ['Bash']
  const args = [
    '-p', '--output-format', 'json',
    '--permission-mode', 'bypassPermissions',
    '--model', model,
  ]
  // A dollar cap only makes sense for API-key billing; under subscription
  // (CLAUDE_CODE_OAUTH_TOKEN) the timeout is the bound.
  if (process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    args.push('--max-budget-usd', process.env.QA_MAX_BUDGET_USD || '2')
  }
  if (process.env.QA_PLAYWRIGHT) {
    const cfg = join(mkdtempSync(join(tmpdir(), 'qa-mcp-')), 'mcp.json')
    writeFileSync(cfg, JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless'] } } }))
    args.push('--mcp-config', cfg, '--strict-mcp-config')
    allowed.push('mcp__playwright')
  }
  // --allowed-tools is variadic and would swallow a positional prompt, so the
  // prompt goes on stdin (the CLI reads it there in --print mode).
  args.push('--allowed-tools', ...allowed)

  const debugFile = join(mkdtempSync(join(tmpdir(), 'qa-dbg-')), 'claude.log')
  args.push('--debug-file', debugFile)

  // Keep a fresh CI install from stalling on first-run chores (native-build
  // fetch, auto-update, telemetry) — network to the API/preview is already fine,
  // so any hang is self-inflicted startup work.
  const env = {
    ...process.env,
    CI: 'true',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }

  let raw
  try {
    raw = execFileSync('claude', args, { input: prompt, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs })
  } catch (err) {
    const partial = [err?.stdout, err?.stderr].filter(Boolean).join('\n').slice(-1200)
    let dbg = ''
    try { dbg = readFileSync(debugFile, 'utf8').slice(-2000) } catch { /* none */ }
    if (dbg) console.error(`--- claude debug tail ---\n${dbg}\n--- end debug ---`)
    if (partial) console.error(`--- claude partial output ---\n${partial}\n--- end ---`)
    if (err?.code === 'ETIMEDOUT') throw new Error(`agent timed out after ${timeoutMs / 1000}s — see debug tail above`)
    throw new Error(`claude CLI failed (${err?.code || err?.status}): ${err?.message}`)
  }
  let result
  try {
    result = JSON.parse(raw).result ?? ''
  } catch {
    result = raw // some versions print the text directly
  }
  const blocks = [...result.matchAll(/```json\s*([\s\S]*?)```/g)]
  if (!blocks.length) throw new Error(`agent produced no json verdict block:\n${result.slice(-500)}`)
  const parsed = JSON.parse(blocks[blocks.length - 1][1])
  return parsed.verdicts ?? []
}

// ---- reporting --------------------------------------------------------------

const STATUS_EMOJI = { pass: '✅', fail: '❌', skip: '⏭️' }

function buildComment(items, verdicts, baseUrl) {
  const byIndex = new Map(verdicts.map((v) => [v.index, v]))
  const rows = items.map((it, i) => {
    const v = byIndex.get(i) ?? { status: 'skip', evidence: 'no verdict returned' }
    const text = it.text.length > 90 ? it.text.slice(0, 87) + '…' : it.text
    return `| ${STATUS_EMOJI[v.status] ?? '❓'} | ${text.replace(/\|/g, '\\|')} | ${(v.evidence ?? '').replace(/\|/g, '\\|')} |`
  })
  const passed = verdicts.filter((v) => v.status === 'pass').length
  return [
    BODY_MARKER,
    `### 🤖 QA agent — ${passed}/${items.length} verified`,
    '',
    `Ran against the preview env (${baseUrl}). Passed items are checked off on this PR; failed/skipped stay unchecked for a human.`,
    '',
    '| | Test-plan item | Evidence |',
    '|---|---|---|',
    ...rows,
    '',
    '_Automated QA — not a merge approval._',
  ].join('\n')
}

async function upsertComment(pr, body) {
  const comments = await ghApi('GET', `/repos/${REPO}/issues/${pr}/comments?per_page=100`)
  const existing = comments.find((c) => c.body?.includes(BODY_MARKER))
  if (existing) {
    await ghApi('PATCH', `/repos/${REPO}/issues/comments/${existing.id}`, { body })
  } else {
    await ghApi('POST', `/repos/${REPO}/issues/${pr}/comments`, { body })
  }
}

// ---- main -------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const pr = Number(args.find((a) => /^\d+$/.test(a)))
  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '')
  if (!pr || !baseUrl) {
    console.error('Usage: run.mjs <prNumber> [--dry-run]   (env: BASE_URL, JWT_SECRET, GITHUB_REPOSITORY, GITHUB_TOKEN)')
    process.exit(2)
  }

  const prData = await ghApi('GET', `/repos/${REPO}/pulls/${pr}`)
  const files = await ghApi('GET', `/repos/${REPO}/pulls/${pr}/files?per_page=100`)
  const { lines, items } = testPlanItems(prData.body)
  if (!items.length) {
    console.log('No `## Test plan` checklist items found — nothing to QA.')
    await upsertComment(pr, `${BODY_MARKER}\n### 🤖 QA agent\n\nNo \`## Test plan\` checklist found in this PR, so there was nothing to verify.`)
    return
  }
  const changedFiles = files.map((f) => `- \`${f.filename}\``).join('\n')

  // Fail fast on a missing credential rather than letting the CLI hang until the
  // timeout — surface the config gap on the PR so a human can fix it. Prefer the
  // subscription OAuth token (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`);
  // accept an ANTHROPIC_API_KEY too.
  if (!dryRun && !process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
    await upsertComment(pr, `${BODY_MARKER}\n### 🤖 QA agent — not run\n\nNo Claude credential on the runner. Set the \`CLAUDE_CODE_OAUTH_TOKEN\` repo secret (from \`claude setup-token\`, uses your subscription) — or \`ANTHROPIC_API_KEY\` — and re-run this job.`)
    throw new Error('No Claude credential (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) — cannot run the QA agent')
  }

  let verdicts
  if (dryRun) {
    verdicts = items.map((_, i) => ({ index: i, status: 'pass', evidence: 'dry-run: not actually verified' }))
  } else {
    verdicts = runAgent(buildPrompt({ baseUrl, token: mintToken(), prTitle: prData.title, changedFiles, items }))
  }

  const passedIdx = verdicts.filter((v) => v.status === 'pass').map((v) => v.index)
  const newBody = tickPassed(lines, items, passedIdx)
  if (newBody !== prData.body) {
    await ghApi('PATCH', `/repos/${REPO}/pulls/${pr}`, { body: newBody })
  }
  await upsertComment(pr, buildComment(items, verdicts, baseUrl))
  console.log(`QA complete: ${passedIdx.length}/${items.length} items verified on ${baseUrl}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
}
