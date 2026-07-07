#!/usr/bin/env node
/**
 * Maintains a single rolling dev → main PR. Run locally or from
 * .github/workflows/rolling-dev-main-pr.yml after each push to dev.
 *
 * Requires: git, gh (authenticated), full git history (fetch-depth: 0).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROMOTION_TITLE_PREFIX = '[promotion] dev → main'
const PROMOTION_LABEL = 'promotion'

function sh(cmd, args = []) {
  return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
}

function shJson(cmd, args = []) {
  return JSON.parse(sh(cmd, args))
}

function extractTestPlan(body) {
  if (!body) return null
  const match = body.match(/## Test plan\r?\n([\s\S]*?)(?:\r?\n## |\s*$)/i)
  if (!match) return null
  const section = match[1].trim()
  return section || null
}

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function buildBody({ version, ahead, commitLines, mergedPrs }) {
  const lines = [
    'Automated rolling promotion PR. **Do not merge until staging is verified** for every included change.',
    '',
    `Staging image: \`:dev\` on \`boop-watch-dev\` · target prod: \`watch.boopurno.es\` · dev version: \`${version}\``,
    '',
    `**${ahead}** commit(s) on \`dev\` ahead of \`main\`.`,
    '',
    '## Production promotion checklist',
    '',
    'Complete after staging verification for all changes below:',
    '',
    '- [ ] Every merged feature PR listed below has its staging test plan checked off',
    '- [ ] `kubectl -n link-apps rollout status deployment/boop-watch-dev --timeout=180s`',
    '- [ ] Staging `/health` and relevant APIs exercised (port-forward or exec)',
    '- [ ] Diff scope matches what was verified on staging',
    '- [ ] Post-merge: `kubectl -n link-apps rollout status deployment/boop-watch --timeout=180s`',
    '- [ ] Smoke `https://watch.boopurno.es/health` and spot-check affected surfaces',
    '',
    '## Included changes',
    '',
  ]

  if (mergedPrs.length > 0) {
    for (const pr of mergedPrs) {
      lines.push(`### [#${pr.number}](${pr.url}) ${pr.title}`)
      lines.push('')
      const plan = extractTestPlan(pr.body)
      if (plan) {
        lines.push('<details>')
        lines.push('<summary>Staging test plan (from feature PR — verify on staging before prod)</summary>')
        lines.push('')
        lines.push(plan)
        lines.push('')
        lines.push('</details>')
        lines.push('')
      } else {
        lines.push('_No test plan section in the feature PR._')
        lines.push('')
      }
    }
  } else {
    lines.push('_No merge commits with PR numbers in this range — direct commits on dev:_')
    lines.push('')
    for (const line of commitLines) lines.push(line)
    lines.push('')
  }

  if (mergedPrs.length > 0 && commitLines.length > 0) {
    lines.push('## Commits')
    lines.push('')
    for (const line of commitLines) lines.push(line)
    lines.push('')
  }

  lines.push('---')
  lines.push('_Updated automatically when `dev` advances. Edit the checklist on this PR only._')

  return lines.join('\n')
}

function findOpenPromotionPr() {
  const prs = shJson('gh', [
    'pr',
    'list',
    '--base',
    'main',
    '--head',
    'dev',
    '--state',
    'open',
    '--json',
    'number,title,labels',
  ])
  return prs.find((p) => p.title.startsWith(PROMOTION_TITLE_PREFIX) || p.labels?.some((l) => l.name === PROMOTION_LABEL)) ?? prs[0] ?? null
}

function ensureLabel() {
  try {
    sh('gh', [
      'label',
      'create',
      PROMOTION_LABEL,
      '--color',
      '1d76db',
      '--description',
      'Rolling dev→main production promotion',
    ])
  } catch {
    // already exists
  }
}

function main() {
  sh('git', ['fetch', 'origin', 'main', 'dev'])

  const ahead = Number(sh('git', ['rev-list', '--count', 'origin/main..origin/dev']))
  const openPr = findOpenPromotionPr()

  if (ahead === 0) {
    if (openPr) {
      sh('gh', ['pr', 'close', String(openPr.number), '--comment', 'Closing: `dev` is even with `main` — nothing to promote.'])
      console.log(`Closed promotion PR #${openPr.number} (dev even with main)`)
    } else {
      console.log('dev is even with main; no promotion PR needed')
    }
    return
  }

  const mergeSubjects = sh('git', ['log', 'origin/main..origin/dev', '--merges', '--pretty=format:%s']).split('\n').filter(Boolean)
  const prNumbers = [
    ...new Set(
      mergeSubjects
        .map((s) => {
          const m = s.match(/Merge pull request #(\d+)/)
          return m ? Number(m[1]) : null
        })
        .filter((n) => n !== null),
    ),
  ]

  const mergedPrs = prNumbers.map((num) => {
    const pr = shJson('gh', ['pr', 'view', String(num), '--json', 'number,title,body,url'])
    return pr
  })

  const commitLines = sh('git', ['log', 'origin/main..origin/dev', '--pretty=format:- %s (`%h`)', '--no-merges'])
    .split('\n')
    .filter(Boolean)

  const version = readVersion()
  const body = buildBody({ version, ahead, commitLines, mergedPrs })
  const title = `${PROMOTION_TITLE_PREFIX} (${version}, ${ahead} commit${ahead === 1 ? '' : 's'})`

  const bodyFile = join(tmpdir(), `boop-watch-promotion-pr-${process.pid}.md`)
  writeFileSync(bodyFile, body)

  ensureLabel()

  if (openPr) {
    sh('gh', ['pr', 'edit', String(openPr.number), '--title', title, '--body-file', bodyFile])
    console.log(`Updated promotion PR #${openPr.number}`)
  } else {
    const url = sh('gh', [
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'dev',
      '--title',
      title,
      '--body-file',
      bodyFile,
      '--label',
      PROMOTION_LABEL,
    ])
    console.log(`Created promotion PR: ${url}`)
  }
}

main()
