/**
 * The ONE Playwright MCP definition.
 *
 * run.mjs already claimed this ("shared by the preflight and the real run so we
 * can never verify one configuration and then run a different one") — but
 * verify-browser.mjs wrote its own copy, so the guard has in fact been proving
 * a *different* configuration than the one QA runs. Both now import this.
 *
 * Two ways to get the server, and the difference is where the version comes
 * from:
 *
 *   - `QA_PLAYWRIGHT_MCP_BIN` — a binary baked into the QA image, pinned
 *     alongside the exact chromium revision it expects (Dockerfile.qa). This is
 *     the path in CI.
 *   - `npx -y @playwright/mcp@latest` — the fallback for a laptop with no image.
 *     It costs a download per run and lets the MCP and chromium drift apart,
 *     which is precisely how the agent ends up with no browser while still
 *     reporting verdicts.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let cached = null

export function playwrightMcp() {
  if (cached) return cached

  const dir = mkdtempSync(join(tmpdir(), 'qa-mcp-'))
  const pwCfg = join(dir, 'playwright.json')
  // --test-type: without it Chromium shows the automation infobar, which shifts
  // the layout and breaks screenshot-based evidence. --no-sandbox: CI (and a
  // container) has no user namespace to sandbox into.
  writeFileSync(pwCfg, JSON.stringify({
    browser: {
      browserName: 'chromium',
      launchOptions: { args: ['--test-type', '--no-sandbox', '--disable-dev-shm-usage'] },
    },
  }))

  const baked = process.env.QA_PLAYWRIGHT_MCP_BIN
  const command = baked || 'npx'
  const args = baked
    ? ['--headless', '--config', pwCfg]
    : ['-y', '@playwright/mcp@latest', '--headless', '--config', pwCfg]

  const mcpConfig = join(dir, 'mcp.json')
  writeFileSync(mcpConfig, JSON.stringify({
    mcpServers: { playwright: { command, args } },
  }))

  cached = { command, args, mcpConfig, baked: Boolean(baked) }
  return cached
}

/**
 * Environment for a child `claude` process.
 *
 * Stripping CLAUDE_CODE* is load-bearing: when QA is launched from inside a
 * Claude Code session these leak into the child and silently suppress MCP
 * loading. The agent then has no browser and happily "verifies" UI items over
 * HTTP — a false pass, and the worst thing this system can do.
 */
export function childEnv(extra = {}) {
  const env = {
    ...process.env,
    CI: 'true',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...extra,
  }
  for (const k of [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
  ]) {
    delete env[k]
  }
  return env
}
