/**
 * GitHub REST access for the QA agent — and a small CLI so workflow steps can
 * reach the API too.
 *
 * The qa-agent job runs on the self-hosted `k3s-cp` runner, which has **no `gh`
 * CLI** (only `ubuntu-latest` ships one). Steps there must not shell out to
 * `gh`. `actions/setup-node` guarantees node, so this module is the supported
 * way for those steps to talk to GitHub.
 *
 *   node scripts/qa-agent/gh.mjs head-sha <pr>          # prints the PR head sha
 *   node scripts/qa-agent/gh.mjs comment <pr> <body>    # posts an issue comment
 *
 * Env: GITHUB_REPOSITORY (or QA_REPO), GITHUB_TOKEN (or GH_TOKEN).
 */

import { pathToFileURL } from 'node:url'

const REPO = process.env.GITHUB_REPOSITORY || process.env.QA_REPO
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN

export async function ghApi(method, path, body, attempt = 1) {
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

/** Head sha of a PR, live — the debounce step compares it against github.sha. */
export async function prHeadSha(pr) {
  const d = await ghApi('GET', `/repos/${REPO}/pulls/${pr}`)
  return d.head.sha
}

export async function prComment(pr, body) {
  await ghApi('POST', `/repos/${REPO}/issues/${pr}/comments`, { body })
}

// CLI — only when run directly, so importing this module stays side-effect free.
// pathToFileURL, not string-concatenation: `file://${argv[1]}` never matches on
// Windows (file:///C:/… vs file://C:\…), which silently disables the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, pr, ...rest] = process.argv.slice(2)
  const usage = 'Usage: gh.mjs head-sha <pr> | gh.mjs comment <pr> <body>'
  try {
    if (cmd === 'head-sha') {
      if (!pr) throw new Error(usage)
      console.log(await prHeadSha(pr))
    } else if (cmd === 'comment') {
      const body = rest.join(' ')
      if (!pr || !body) throw new Error(usage)
      await prComment(pr, body)
    } else {
      throw new Error(usage)
    }
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }
}
