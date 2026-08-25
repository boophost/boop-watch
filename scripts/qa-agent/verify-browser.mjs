#!/usr/bin/env node
/**
 * Regression guard: prove the QA agent really drives a browser for UI items.
 *
 *   BASE_URL=http://<preview> node scripts/qa-agent/verify-browser.mjs
 *
 * Why this exists: the Playwright MCP can fail to load *silently* (leaked
 * CLAUDECODE/CLAUDE_CODE_* env vars from a parent Claude Code session suppress
 * it). The agent then has no browser — and happily "verifies" a UI item with a
 * curl of the page instead. For a client-rendered SPA that proves nothing: the
 * HTML shell is identical whether the app renders or crashes on boot. That is a
 * false pass, and it is the worst thing this QA system could do.
 *
 * So don't trust the agent's prose. Run it with `--output-format stream-json`,
 * read the actual tool_use blocks, and fail if a UI item passed without a real
 * mcp__playwright__* call.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { filterCredentials, getEarliestReset, credentialPool } from './cooldown.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '')
if (!BASE_URL) {
  console.error('Usage: BASE_URL=http://<preview> node scripts/qa-agent/verify-browser.mjs')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'qa-verify-'))
const pwCfg = join(dir, 'playwright.json')
writeFileSync(pwCfg, JSON.stringify({
  browser: { browserName: 'chromium', launchOptions: { args: ['--test-type', '--no-sandbox', '--disable-dev-shm-usage'] } },
}))
const mcpConfig = join(dir, 'mcp.json')
writeFileSync(mcpConfig, JSON.stringify({
  mcpServers: { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless', '--config', pwCfg] } },
}))

const prompt = `You are QA. Verify this ONE item against ${BASE_URL}:

0. The portal home page renders a grid of poster cards (not an empty state or an error)

Navigate to EXACTLY \`${BASE_URL}\` — it is the complete, working base URL. Do NOT
append a port, and do not "correct" it to :3000 or any other port (the app is
behind a Service on port 80; adding a port makes it unreachable).

The portal is a client-rendered React SPA: curling the HTML proves NOTHING about
what renders. You MUST verify with the mcp__playwright__* browser tools (navigate,
then snapshot/screenshot). If you have no browser tool, mark it skip — never pass
it on HTTP evidence.

Output a single fenced json block, nothing after:
\`\`\`json
{"verdicts":[{"index":0,"status":"pass","evidence":"..."}]}
\`\`\``

// Same strip as run.mjs — these suppress MCP loading in a child session.
const env = { ...process.env }
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION']) delete env[k]

// Same pool + cooldown filter as run.mjs — a capped account must not look like
// a broken browser. Only OAuth tokens here (API-key billing doesn't hit the
// same subscription 429 path this guard rotates through).
const allCreds = credentialPool().filter((c) => c.kind === 'oauth')
const validCreds = filterCredentials(allCreds)
if (allCreds.length > 0 && validCreds.length === 0) {
  console.log(`All credentials are on cooldown until ${getEarliestReset(allCreds) || 'unknown'}. Skipping verify-browser since agent will skip too.`)
  process.exit(0)
}
const tokens = validCreds.map((c) => c.env.CLAUDE_CODE_OAUTH_TOKEN).filter(Boolean)

// Read the structured `result` event rather than string-sniffing the whole
// stream: a *previous* credential's 429 text lingers in the buffer and would
// otherwise make a working credential look rate limited — the guard would then
// silently disable itself, which is worse than having no guard at all.
function isRateLimited(stream) {
  for (const line of stream.split('\n')) {
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type !== 'result') continue
    if (ev.api_error_status === 429) return true
    if (/session limit|usage limit|rate limit/i.test(String(ev.result ?? ''))) return true
  }
  return false
}

let raw = ''
let rateLimited = false
for (const token of tokens.length ? tokens : [null]) {
  const runEnv = token ? { ...env, CLAUDE_CODE_OAUTH_TOKEN: token } : env
  try {
    raw = execFileSync('claude', [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--model', process.env.QA_MODEL || 'claude-haiku-4-5',
      '--mcp-config', mcpConfig, '--strict-mcp-config',
      '--allowed-tools', 'Bash', 'mcp__playwright',
    ], { input: prompt, env: runEnv, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 10 * 60_000 })
  } catch (err) {
    raw = [err?.stdout, err?.stderr].filter(Boolean).join('\n')
  }
  rateLimited = isRateLimited(raw)
  if (!rateLimited) break
}
if (rateLimited) {
  console.warn('⚠️  All credentials rate limited — cannot verify the browser here. Skipping the guard (the agent itself will still refuse to pass UI items without a browser).')
  process.exit(0)
}

const toolCalls = []
let finalResult = ''
// Whether *claude itself* failed, as opposed to running fine without a browser.
// Without this the two are indistinguishable downstream, and they have opposite
// fixes — see the failure branch below.
let agentError = ''
for (const line of raw.split('\n')) {
  if (!line.trim()) continue
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  if (ev.type === 'assistant') {
    for (const b of ev.message?.content ?? []) if (b.type === 'tool_use') toolCalls.push(b.name)
    if (ev.is_api_error_message || ev.error) {
      const text = (ev.message?.content ?? []).find((b) => b.type === 'text')?.text ?? ''
      agentError = [ev.error, text].filter(Boolean).join(': ')
    }
  }
  if (ev.type === 'result') {
    finalResult = ev.result ?? ''
    if (ev.is_error && !agentError) {
      agentError = [ev.api_error_status && `HTTP ${ev.api_error_status}`, ev.result].filter(Boolean).join(': ')
    }
  }
}

const usedBrowser = toolCalls.some((t) => t.startsWith('mcp__playwright'))
const blocks = [...finalResult.matchAll(/```json\s*([\s\S]*?)```/g)]
const verdict = blocks.length ? JSON.parse(blocks[blocks.length - 1][1]).verdicts?.[0] : null

console.log('tool calls:', JSON.stringify(toolCalls))
console.log('used browser:', usedBrowser)
console.log('verdict:', JSON.stringify(verdict))

if (!usedBrowser) {
  // "No browser tool" has two very different causes and they were previously
  // reported identically. An expired CLAUDE_CODE_OAUTH_TOKEN produces the exact
  // same three lines as a genuinely broken MCP — and the old message sent you
  // debugging Chromium and npx while the real fix was `claude setup-token`.
  // If the agent never got off the ground, say so and stop guessing.
  if (agentError) {
    console.error(`\n❌ The agent could not run at all: ${agentError}`)
    console.error('   This is NOT a browser problem — claude never reached the point of calling a tool.')
    if (/not logged in|authentication|unauthor/i.test(agentError)) {
      console.error('   Fix: mint a fresh token with `claude setup-token` and update the')
      console.error('   CLAUDE_CODE_OAUTH_TOKEN repo secret (and _2/_3 if you pool accounts).')
    }
    process.exit(1)
  }
  console.error('\n❌ The agent ran but never called a browser tool — the Playwright MCP is not loading.')
  console.error('   Check: `npx -y @playwright/mcp@latest --headless` starts and advertises browser_* tools,')
  console.error('   and that ~/.cache/ms-playwright has the chromium build it expects.')
  if (verdict?.status === 'pass') console.error('   Worse: it PASSED a UI item anyway. That is a false pass.')
  process.exit(1)
}
if (verdict?.status !== 'pass') {
  console.error(`\n❌ Browser worked but the item did not pass (status=${verdict?.status}): ${verdict?.evidence}`)
  process.exit(1)
}
console.log('\n✅ Honest pass: the agent genuinely drove a browser to verify a UI item.')
