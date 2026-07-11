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
import { join } from 'node:path'

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

// Try each pooled credential, same as run.mjs — a capped account must not look
// like a broken browser.
const tokens = [
  process.env.CLAUDE_CODE_OAUTH_TOKEN,
  process.env.CLAUDE_CODE_OAUTH_TOKEN_2,
  process.env.CLAUDE_CODE_OAUTH_TOKEN_3,
].filter((t) => t?.trim())

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
  rateLimited = /rate[_ ]limit|"api_error_status"\s*:\s*429|session limit|usage limit/i.test(raw)
  if (!rateLimited) break
}
if (rateLimited) {
  console.warn('⚠️  All credentials rate limited — cannot verify the browser here. Skipping the guard (the agent itself will still refuse to pass UI items without a browser).')
  process.exit(0)
}

const toolCalls = []
let finalResult = ''
for (const line of raw.split('\n')) {
  if (!line.trim()) continue
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  if (ev.type === 'assistant') {
    for (const b of ev.message?.content ?? []) if (b.type === 'tool_use') toolCalls.push(b.name)
  }
  if (ev.type === 'result') finalResult = ev.result ?? ''
}

const usedBrowser = toolCalls.some((t) => t.startsWith('mcp__playwright'))
const blocks = [...finalResult.matchAll(/```json\s*([\s\S]*?)```/g)]
const verdict = blocks.length ? JSON.parse(blocks[blocks.length - 1][1]).verdicts?.[0] : null

console.log('tool calls:', JSON.stringify(toolCalls))
console.log('used browser:', usedBrowser)
console.log('verdict:', JSON.stringify(verdict))

if (!usedBrowser) {
  console.error('\n❌ The agent never called a browser tool — the Playwright MCP is not loading.')
  if (verdict?.status === 'pass') console.error('   Worse: it PASSED a UI item anyway. That is a false pass.')
  process.exit(1)
}
if (verdict?.status !== 'pass') {
  console.error(`\n❌ Browser worked but the item did not pass (status=${verdict?.status}): ${verdict?.evidence}`)
  process.exit(1)
}
console.log('\n✅ Honest pass: the agent genuinely drove a browser to verify a UI item.')
