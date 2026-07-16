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
 *                      `claude setup-token`). Add CLAUDE_CODE_OAUTH_TOKEN_2..N
 *                      (or a newline/comma-separated CLAUDE_CODE_OAUTH_TOKENS)
 *                      to pool several accounts: when one hits its usage cap the
 *                      agent rotates to the next. ANTHROPIC_API_KEY is tried last
 *                      (per-token billing). Not needed for --dry-run.
 *   QA_LOCAL_CLAUDE=1  use the machine's existing `claude` login instead
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
import { filterCredentials, areAllCooling, getEarliestReset, recordCooldown, credentialPool } from './cooldown.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLAN_HEADING = '## test plan'
const BODY_MARKER = '<!-- qa-agent -->'
const NS = process.env.QA_NAMESPACE || 'link-apps'
const REPO = process.env.GITHUB_REPOSITORY || process.env.QA_REPO
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN

// ---- GitHub REST ------------------------------------------------------------

async function ghApi(method, path, body, attempt = 1) {
  if (!REPO || !TOKEN) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required')
  let res
  try {
    res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    // Network-level failure (ECONNRESET/ETIMEDOUT/DNS). `fetch failed` hides the
    // real reason in err.cause — surface it, and retry with backoff.
    const cause = err?.cause?.code || err?.cause?.message || err?.message
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)))
      return ghApi(method, path, body, attempt + 1)
    }
    throw new Error(`GitHub ${method} ${path} failed after ${attempt} attempts: ${cause}`)
  }
  // Retry transient server/rate-limit statuses too.
  if ((res.status >= 500 || res.status === 429) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)))
    return ghApi(method, path, body, attempt + 1)
  }
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

// Try each credential in turn; a usage/rate limit rotates to the next account.
// Only when every credential is capped do we report the run as deferred.
function runAgentWithFailover(prompt, creds) {
  const limits = []
  for (const [i, cred] of creds.entries()) {
    try {
      if (i > 0) console.log(`Rotating to credential: ${cred.name}`)
      return runAgent(prompt, cred)
    } catch (err) {
      if (!(err instanceof RateLimitError) || i === creds.length - 1) {
        if (err instanceof RateLimitError) {
          recordCooldown(cred.name, err.rawReason || err.message)
          limits.push(`${cred.name}: ${err.message}`)
        }
        if (err instanceof RateLimitError) throw new RateLimitError(limits.join(' | '), limits.join(' | '))
        throw err
      }
      console.warn(`Credential ${cred.name} is rate limited (${err.message}) — trying the next one.`)
      recordCooldown(cred.name, err.rawReason || err.message)
      limits.push(`${cred.name}: ${err.message}`)
    }
  }
  throw new RateLimitError(limits.join(' | ') || 'no Claude credentials available')
}

// One Playwright MCP definition, shared by the preflight and the real run so we
// can never verify one configuration and then run a different one. Chromium
// needs --test-type (the automation infobar otherwise shifts layout and breaks
// screenshots) and CI has no sandbox namespace.
let _pwMcp = null
function playwrightMcp() {
  if (_pwMcp) return _pwMcp
  const dir = mkdtempSync(join(tmpdir(), 'qa-mcp-'))
  const pwCfg = join(dir, 'playwright.json')
  writeFileSync(pwCfg, JSON.stringify({
    browser: {
      browserName: 'chromium',
      launchOptions: { args: ['--test-type', '--no-sandbox', '--disable-dev-shm-usage'] },
    },
  }))
  const args = ['-y', '@playwright/mcp@latest', '--headless', '--config', pwCfg]
  const mcpConfig = join(dir, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({
    mcpServers: { playwright: { command: 'npx', args } },
  }))
  _pwMcp = { args, mcpConfig }
  return _pwMcp
}

// Preflight the browser: boot the Playwright MCP and confirm it exposes the
// browser_* tools. Cached for the process. Without this the agent can silently
// end up with no browser and "verify" UI items over HTTP instead — a false pass.
let _browserWorks = null
function browserWorks() {
  if (!process.env.QA_PLAYWRIGHT) return false
  if (_browserWorks !== null) return _browserWorks
  const req = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'qa', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ].join('\n') + '\n'
  try {
    const { args } = playwrightMcp()
    const out = execFileSync('npx', args, { input: req, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] })
    _browserWorks = out.includes('browser_navigate')
  } catch {
    _browserWorks = false
  }
  if (!_browserWorks) console.warn('Playwright MCP did not expose browser tools — UI items will be skipped, not guessed.')
  return _browserWorks
}

// Advertise kubectl only when it actually works here — an agent told it has a
// tool it can't use wastes turns, and one not told it has kubectl needlessly
// skips pod/env/mount claims it could have proven (seen in both directions).
function kubeNote(pr) {
  try {
    execFileSync('kubectl', ['-n', NS, 'get', 'deploy', `boop-watch-pr-${pr}`, '-o', 'name'], { stdio: 'pipe', timeout: 20_000 })
  } catch {
    return '- No cluster access — mark items that need `kubectl` as `skip`.'
  }
  return [
    `- \`kubectl\` **works** (namespace \`${NS}\`). The preview's objects are:`,
    `  Deployment/Service \`boop-watch-pr-${pr}\`, PVC \`boop-watch-pr-${pr}-data\`,`,
    `  IngressRoute \`boop-watch-pr-${pr}\` (all labelled \`boop-watch.dev/preview-pr=${pr}\`).`,
    '  Use it to prove pod-level claims rather than skipping them, e.g.:',
    `  \`kubectl -n ${NS} get pods -l app.kubernetes.io/name=boop-watch-pr-${pr}\`,`,
    `  \`kubectl -n ${NS} exec deploy/boop-watch-pr-${pr} -- env\` (check QBIT_*/LIBRARY_DIR are empty),`,
    `  \`kubectl -n ${NS} exec deploy/boop-watch-pr-${pr} -- sh -c 'ls /data || echo no-mount'\`.`,
    '  Staging is `boop-watch-dev` and prod is `boop-watch` — a test-plan item naming those',
    '  refers to the *shared* env, which this PR has not been deployed to yet: verify the',
    '  equivalent behavior on the preview instead, and say so in the evidence.',
  ].join('\n')
}

function buildPrompt({ baseUrl, token, prTitle, changedFiles, items, pr }) {
  const template = readFileSync(join(HERE, 'prompt.md'), 'utf8')
  const playwrightNote = browserWorks()
    ? [
        'A real browser is available via the Playwright MCP (`mcp__playwright__*`) —',
        '  **use it for any item about rendering, clicking, menus, dialogs, or layout**; those are',
        '  client-rendered (React SPA), so an HTTP call cannot prove them. Navigate to',
        `  \`${baseUrl}\`, interact, and take a snapshot/screenshot as evidence.`,
        '  The public portal (`/`, `/series/:id`, `/watch/:id`, `/schedule`) needs no login.',
        '  `/manage` is behind Supabase auth: seed a session before navigating, e.g.',
        '  `mcp__playwright__browser_evaluate` with',
        "  `() => localStorage.setItem('sb-<ref>-auth-token', JSON.stringify({access_token:'<TOKEN>',token_type:'bearer',expires_at:9999999999,refresh_token:'x',user:{id:'qa',email:'qa@local'}}))`",
        '  then reload. If a UI check genuinely cannot be driven, say exactly what blocked it.',
      ].join('\n')
    : 'No browser is available — verify via HTTP; mark genuinely UI-only items `skip`.'
  return template
    .replaceAll('{{KUBE_NOTE}}', kubeNote(pr))
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
// `cred` selects which account/key the CLI authenticates with (see credentialPool).
function runAgent(prompt, cred) {
  const model = process.env.QA_MODEL || 'claude-haiku-4-5'
  const timeoutMs = Number(process.env.QA_TIMEOUT_MS || 8 * 60_000)

  const allowed = ['Bash']
  const args = [
    '-p', '--output-format', 'json',
    '--permission-mode', 'bypassPermissions',
    '--model', model,
  ]
  // A dollar cap only makes sense for API-key billing; under a subscription the
  // timeout is the bound.
  if (cred.kind === 'api-key') {
    args.push('--max-budget-usd', process.env.QA_MAX_BUDGET_USD || '2')
  }
  if (browserWorks()) {
    args.push('--mcp-config', playwrightMcp().mcpConfig, '--strict-mcp-config')
    allowed.push('mcp__playwright')
  }
  // --allowed-tools is variadic and would swallow a positional prompt, so the
  // prompt goes on stdin (the CLI reads it there in --print mode).
  args.push('--allowed-tools', ...allowed)

  const debugFile = join(mkdtempSync(join(tmpdir(), 'qa-dbg-')), 'claude.log')
  args.push('--debug-file', debugFile)

  // Keep a fresh CI install from stalling on first-run chores (native-build
  // fetch, auto-update, telemetry) — network to the API/preview is already fine,
  // so any hang is self-inflicted startup work. `...cred.env` pins exactly one
  // credential for this run (the others are blanked) so a rotation really does
  // switch accounts.
  const env = {
    ...process.env,
    CI: 'true',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...cred.env,
  }
  // When run from inside a Claude Code session these leak into the child and
  // silently suppress MCP loading — the agent then has no browser but happily
  // "verifies" UI items over HTTP. Strip them so the child is a clean session.
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION']) {
    delete env[k]
  }

  let raw
  try {
    raw = execFileSync('claude', args, { input: prompt, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs })
  } catch (err) {
    const partial = [err?.stdout, err?.stderr].filter(Boolean).join('\n').slice(-1200)
    let dbg = ''
    try { dbg = readFileSync(debugFile, 'utf8').slice(-2000) } catch { /* none */ }
    // A usage/rate limit is not a QA failure — the CLI exits non-zero, but
    // nothing was verified either way. Signal it so the caller can defer.
    const limited = detectRateLimit(err?.stdout, partial, dbg)
    if (limited) throw new RateLimitError(limited.msg, limited.raw)
    if (dbg) console.error(`--- claude debug tail ---\n${dbg}\n--- end debug ---`)
    if (partial) console.error(`--- claude partial output ---\n${partial}\n--- end ---`)
    if (err?.code === 'ETIMEDOUT') throw new Error(`agent timed out after ${timeoutMs / 1000}s — see debug tail above`)
    throw new Error(`claude CLI failed (${err?.code || err?.status}): ${err?.message}`)
  }
  let result
  try {
    const out = JSON.parse(raw)
    const limited = detectRateLimit(raw)
    if (limited) throw new RateLimitError(limited.msg, limited.raw)
    result = out.result ?? ''
  } catch (err) {
    if (err instanceof RateLimitError) throw err
    result = raw // some versions print the text directly
  }
  return parseVerdicts(result)
}

// Pull the verdict(s) out of the agent's final message. The model is asked for
// one JSON object per line inside a ```json block (prompt.md), which makes
// partial recovery trivial — a single malformed line (an unescaped quote or
// stray newline in an `evidence` string) no longer sinks the whole run. We still
// accept the older `{"verdicts":[...]}` / bare-array shapes. Returns
// `{ verdicts, unreadable }`: `unreadable` is a tail of the output when nothing
// at all could be salvaged, so the caller can report instead of crashing.
function parseVerdicts(result) {
  const tail = result.slice(-800).trim()
  const blocks = [...result.matchAll(/```json\s*([\s\S]*?)```/g)]
  if (!blocks.length) return { verdicts: [], unreadable: tail }
  const block = blocks[blocks.length - 1][1].trim()

  const isVerdict = (v) => v && typeof v === 'object' && typeof v.index === 'number'

  // Whole-block parse first — handles {"verdicts":[...]}, a bare [...] array, or
  // a single {...} object. JSONL (the format we now ask for) fails here and
  // falls through to the line-by-line salvage below.
  try {
    const whole = JSON.parse(block)
    const verdicts = Array.isArray(whole) ? whole : (whole.verdicts ?? [whole])
    if (Array.isArray(verdicts) && verdicts.some(isVerdict)) {
      return { verdicts: verdicts.filter(isVerdict), unreadable: null }
    }
  } catch { /* fall through to line-by-line salvage */ }

  // Salvage line-by-line: keep every line that parses to a verdict object, drop
  // the rest. One stray line no longer discards the good ones.
  const verdicts = []
  for (const line of block.split(/\r?\n/)) {
    const s = line.trim().replace(/,\s*$/, '') // tolerate trailing array commas
    if (!s || '{}[]'.includes(s)) continue
    try {
      const obj = JSON.parse(s)
      if (isVerdict(obj)) verdicts.push(obj)
    } catch { /* skip this unparseable line */ }
  }
  return verdicts.length ? { verdicts, unreadable: null } : { verdicts: [], unreadable: tail }
}

class RateLimitError extends Error {
  constructor(message, rawReason) {
    super(message)
    this.rawReason = rawReason
  }
}

// The CLI reports a usage cap as api_error_status 429 / a "session limit"
// result. Pull out a human-readable reason (incl. the reset time when present).
function detectRateLimit(...texts) {
  const blob = texts.filter(Boolean).join('\n')
  if (!blob) return null
  if (!/rate[_ ]limit|"api_error_status"\s*:\s*429|session limit|usage limit/i.test(blob)) return null
  const reset = blob.match(/resets?[^"\n]*/i)?.[0]?.trim()
  return {
    msg: reset ? `Claude usage limit reached (${reset}).` : 'Claude usage/rate limit reached.',
    raw: reset || 'Claude usage/rate limit reached.'
  }
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

// Posted when the agent ran but its verdict block couldn't be parsed at all.
// Better than a silent exit-1: the human sees QA ran, that nothing was ticked,
// and the tail of the raw output to judge from.
function buildUnreadableComment(items, baseUrl, tail) {
  const fenced = tail.replace(/```/g, '`​``') // neutralize fences in the tail
  return [
    BODY_MARKER,
    '### 🤖 QA agent — verdict unreadable',
    '',
    `Ran against the preview env (${baseUrl}) but did not emit a parseable JSON verdict block, so none of the ${items.length} item(s) were checked off. A human should review the run and the output below.`,
    '',
    '<details><summary>Output tail</summary>',
    '',
    '```',
    fenced,
    '```',
    '',
    '</details>',
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
  let { lines, items } = testPlanItems(prData.body)
  
  if (args.includes('--catch-up')) {
    // Only test the unchecked items
    items = items.filter(it => !it.checked)
    if (items.length === 0) {
      console.log('No unchecked items in test plan to catch up.')
      return
    }
  }

  if (!items.length) {
    console.log('No `## Test plan` checklist items found — nothing to QA.')
    await upsertComment(pr, `${BODY_MARKER}\n### 🤖 QA agent\n\nNo \`## Test plan\` checklist found in this PR, so there was nothing to verify.`)
    return
  }
  const changedFiles = files.map((f) => `- \`${f.filename}\``).join('\n')

  // Fail fast on a missing credential rather than letting the CLI hang until the
  // timeout — surface the config gap on the PR so a human can fix it.
  const allCreds = credentialPool()
  const creds = filterCredentials(allCreds)
  if (!dryRun && !allCreds.length) {
    await upsertComment(pr, `${BODY_MARKER}\n### 🤖 QA agent — not run\n\nNo Claude credential on the runner. Set the \`CLAUDE_CODE_OAUTH_TOKEN\` repo secret (from \`claude setup-token\`, uses your subscription) — or \`ANTHROPIC_API_KEY\` — and re-run this job.`)
    throw new Error('No Claude credential (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) — cannot run the QA agent')
  }
  if (!dryRun) console.log(`Claude credentials available: ${creds.map((c) => c.name).join(', ')}`)

  let verdicts
  let unreadable = null
  if (dryRun) {
    verdicts = items.map((_, i) => ({ index: i, status: 'pass', evidence: 'dry-run: not actually verified' }))
  } else {
    try {
      const res = runAgentWithFailover(buildPrompt({ baseUrl, token: mintToken(), prTitle: prData.title, changedFiles, items, pr }), creds)
      verdicts = res.verdicts
      unreadable = res.unreadable
    } catch (err) {
      // Every credential is capped — nothing was verified, but that's not a QA
      // failure either. Say so on the PR, tick nothing, and exit clean so the
      // check isn't a misleading red X. Re-run once usage resets.
      if (err instanceof RateLimitError) {
        await upsertComment(pr, `${BODY_MARKER}\n### 🤖 QA agent — deferred\n\nAll Claude credential(s) are rate limited, so nothing was verified and no items were checked off. Re-run this job once usage resets.\n\n<details><summary>Details</summary>\n\n${err.message}\n\n</details>`)
        console.log(`QA deferred (all credential(s) rate limited): ${err.message}`)
        return
      }
      throw err
    }
  }

  // The agent ran but emitted no parseable verdict block at all (malformed JSON,
  // or none emitted). Don't crash — post what we have so the run isn't silently
  // lost to a red X, and leave every item unchecked for a human to review.
  if (unreadable && !verdicts.length) {
    await upsertComment(pr, buildUnreadableComment(items, baseUrl, unreadable))
    console.log('QA ran but produced no parseable verdicts — posted the output tail for a human.')
    return
  }

  const passedIdx = verdicts.filter((v) => v.status === 'pass').map((v) => v.index)
  const newBody = tickPassed(lines, items, passedIdx)
  const bodyChanged = newBody !== prData.body
  if (bodyChanged) {
    await ghApi('PATCH', `/repos/${REPO}/pulls/${pr}`, { body: newBody })
  }
  await upsertComment(pr, buildComment(items, verdicts, baseUrl))
  console.log(`QA complete: ${passedIdx.length}/${items.length} items verified on ${baseUrl}`)

  // Close the loop: refresh the rolling dev→main promotion PR so the ticks we
  // just applied propagate into its checklist, which re-runs the promotion gate
  // via the PR `edited` event. Best-effort and only when we actually changed
  // something. Skip with QA_REFRESH_PROMOTION=0.
  if (bodyChanged && passedIdx.length > 0) await refreshPromotion()
}

// Dispatch the rolling promotion workflow (workflow_dispatch on dev). It
// re-aggregates merged feature PRs' current tick state into the promotion PR
// body; editing that body re-runs the promotion-checklist gate. Needs the token
// to have `actions: write`.
async function refreshPromotion() {
  if (process.env.QA_REFRESH_PROMOTION === '0') return
  const wf = process.env.PROMOTION_WORKFLOW || 'rolling-dev-main-pr.yml'
  try {
    await ghApi('POST', `/repos/${REPO}/actions/workflows/${wf}/dispatches`, { ref: 'dev' })
    console.log(`Triggered ${wf} to refresh the promotion PR + re-run its gate.`)
  } catch (err) {
    console.warn(`(promotion refresh skipped: ${String(err?.message || err).split('\n')[0]})`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(String(err?.message || err)); process.exit(1) })
}
