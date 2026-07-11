#!/usr/bin/env node
/**
 * Per-PR preview environments for boop-watch.
 *
 *   node scripts/preview-env.mjs up   <prNumber> <imageRef> [--comment]
 *   node scripts/preview-env.mjs down <prNumber>
 *
 * `up` creates (or re-applies, idempotently) an isolated clone of the
 * boop-watch-dev Deployment for one open feature PR: its own PVC, Service, and
 * Traefik IngressRoute (`pr-<N>-watch.boopurno.es`), with `series.sqlite` seeded
 * from the live dev DB. The flow SINK is neutralised — no qBittorrent env and no
 * media-NFS mount — so N previews run in parallel without colliding on the
 * shared library/qBittorrent. Everything else (portal, /manage, flow editor +
 * dry-runs) works. `down` deletes every object for that PR.
 *
 * The pod spec is derived from the *live* boop-watch-dev Deployment (not
 * hardcoded) so it tracks dev's drift. Requires `kubectl` with a KUBECONFIG that
 * can CRUD Deployments/Services/PVCs/IngressRoutes in link-apps; `up` also needs
 * the dev pod running (it is the DB seed source). `--comment` upserts a sticky PR
 * comment via `gh` (best-effort; skipped if gh/GH_TOKEN is unavailable).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const NS = 'link-apps'
const SRC_DEPLOY = 'boop-watch-dev'
const SRC_SVC = 'boop-watch-dev'
const SRC_INGRESSROUTE = 'boop-watch-dev'
const PREVIEW_LABEL = 'boop-watch.dev/preview-pr'
const NAME_LABEL = 'app.kubernetes.io/name'
const HOST_SUFFIX = '-watch.boopurno.es' // pr-<N>-watch.boopurno.es
const DATA_MOUNT = '/app/data'
const DB_FILE = `${DATA_MOUNT}/series.sqlite`
const MAX_PREVIEWS = Number(process.env.MAX_PREVIEWS || 5)
// Generous: a cold GHCR pull of the ~145MB image can take minutes on a DNS/
// registry blip, and blowing the rollout wait fails the whole preview.
const ROLLOUT_TIMEOUT = process.env.ROLLOUT_TIMEOUT || '420s'

// Env keys and volumes that make the pod able to *write* the shared library /
// drive qBittorrent. Stripped so parallel previews can't collide. POSTHOG_KEY is
// blanked too so preview traffic doesn't pollute the prod analytics project.
const SINK_ENV_KEYS = ['QBIT_URL', 'QBIT_USERNAME', 'QBIT_PASSWORD', 'LIBRARY_DIR']
const BLANK_ENV_KEYS = [...SINK_ENV_KEYS, 'POSTHOG_KEY']

// Snapshot the source series.sqlite to /tmp/seed.sqlite. sqlite3 `.backup` is
// the primary path (image ships it); the node/better-sqlite3 `VACUUM INTO` is a
// fallback for a source pod still on an image without the CLI.
const SNAPSHOT_SH =
  'rm -f /tmp/seed.sqlite*; ' +
  'if command -v sqlite3 >/dev/null 2>&1; then ' +
  'sqlite3 /app/data/series.sqlite ".backup /tmp/seed.sqlite"; ' +
  'else cd /app && node -e \'require("better-sqlite3")("/app/data/series.sqlite",{readonly:true}).exec("VACUUM INTO \\x27/tmp/seed.sqlite\\x27")\'; fi'

const names = (pr) => ({
  deploy: `boop-watch-pr-${pr}`,
  pvc: `boop-watch-pr-${pr}-data`,
  svc: `boop-watch-pr-${pr}`,
  ingressroute: `boop-watch-pr-${pr}`,
  host: `pr-${pr}${HOST_SUFFIX}`,
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function kubectl(args, { input, quiet } = {}) {
  return execFileSync('kubectl', ['-n', NS, ...args], {
    input,
    encoding: 'utf8',
    stdio: input !== undefined ? ['pipe', 'pipe', quiet ? 'pipe' : 'inherit'] : ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'],
  }).trim()
}

function kubectlJson(args) {
  return JSON.parse(execFileSync('kubectl', ['-n', NS, ...args, '-o', 'json'], { encoding: 'utf8' }))
}

function apply(obj) {
  kubectl(['apply', '-f', '-'], { input: JSON.stringify(obj) })
}

function podFor(deploy) {
  const pods = kubectlJson(['get', 'pods', '-l', `${NAME_LABEL}=${deploy}`, '--field-selector', 'status.phase=Running'])
  const pod = pods.items?.[0]
  if (!pod) throw new Error(`no running pod for ${deploy}`)
  return pod.metadata.name
}

// ---- object builders (derived from the live dev objects) --------------------

function buildDeployment(pr, imageRef, src) {
  const n = names(pr)
  const srcContainer = src.spec.template.spec.containers[0]

  const env = (srcContainer.env ?? [])
    .filter((e) => !BLANK_ENV_KEYS.includes(e.name))
    .concat(BLANK_ENV_KEYS.map((name) => ({ name, value: '' }))) // explicit blanks win over any envFrom

  const volumeMounts = (srcContainer.volumeMounts ?? []).filter((m) => m.mountPath === DATA_MOUNT)

  const labels = { [NAME_LABEL]: n.deploy, [PREVIEW_LABEL]: String(pr) }

  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: n.deploy, namespace: NS, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { [NAME_LABEL]: n.deploy } },
      strategy: { type: 'Recreate' }, // RWO PVC: don't run two pods against one volume
      template: {
        metadata: { labels },
        spec: {
          imagePullSecrets: src.spec.template.spec.imagePullSecrets, // ghcr-boophost — private image
          containers: [{
            ...srcContainer,
            name: n.deploy,
            image: imageRef,
            imagePullPolicy: 'Always',
            env,
            envFrom: srcContainer.envFrom, // reuse boop-watch-dev-secret (JWT_SECRET, etc.)
            volumeMounts,
            resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '640Mi' } },
            // dev has no probe, so `rollout status` returns before Express binds
            // :3000. Gate readiness on /health so status/Service/health-check all
            // wait for a pod that actually serves.
            readinessProbe: { httpGet: { path: '/health', port: 3000 }, initialDelaySeconds: 2, periodSeconds: 3, failureThreshold: 30 },
          }],
          volumes: [{ name: 'data', persistentVolumeClaim: { claimName: n.pvc } }],
        },
      },
    },
  }
}

function buildPvc(pr) {
  const n = names(pr)
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: n.pvc, namespace: NS, labels: { [PREVIEW_LABEL]: String(pr) } },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: 'local-path',
      resources: { requests: { storage: '2Gi' } },
    },
  }
}

function buildService(pr, src) {
  const n = names(pr)
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: n.svc, namespace: NS, labels: { [NAME_LABEL]: n.svc, [PREVIEW_LABEL]: String(pr) } },
    spec: {
      selector: { [NAME_LABEL]: n.deploy },
      ports: src.spec.ports.map((p) => ({ name: p.name, port: p.port, targetPort: p.targetPort, protocol: p.protocol })),
    },
  }
}

function buildIngressRoute(pr, src) {
  const n = names(pr)
  return {
    apiVersion: 'traefik.io/v1alpha1',
    kind: 'IngressRoute',
    metadata: { name: n.ingressroute, namespace: NS, labels: { [PREVIEW_LABEL]: String(pr) } },
    spec: {
      entryPoints: src.spec.entryPoints,
      routes: [{
        kind: 'Rule',
        match: `Host(\`${n.host}\`)`,
        services: [{ name: n.svc, port: 80 }],
      }],
    },
  }
}

// ---- DB seed ----------------------------------------------------------------

function seedDb(pr) {
  const n = names(pr)
  const tmp = mkdtempSync(join(tmpdir(), 'boop-preview-'))
  const localSeed = join(tmp, 'seed.sqlite')
  try {
    // Consistent snapshot while dev keeps serving. Prefer the sqlite3 CLI
    // (`.backup`); fall back to better-sqlite3's `VACUUM INTO` for source pods
    // on an image built before sqlite3 was added (both produce a clean file).
    const devPod = podFor(SRC_DEPLOY)
    kubectl(['exec', devPod, '--', 'sh', '-c', SNAPSHOT_SH])
    kubectl(['cp', `${NS}/${devPod}:/tmp/seed.sqlite`, localSeed], { quiet: true })

    // Wait for the preview pod, then swap the freshly-migrated empty DB for the
    // seed. rm unlinks the file the running app holds open (its fd survives);
    // the rollout-restart below then opens the seed cleanly.
    kubectl(['rollout', 'status', `deployment/${n.deploy}`, `--timeout=${ROLLOUT_TIMEOUT}`])
    const previewPod = podFor(n.deploy)
    kubectl(['exec', previewPod, '--', 'sh', '-c', `rm -f ${DB_FILE}*`])
    kubectl(['cp', localSeed, `${NS}/${previewPod}:${DB_FILE}`], { quiet: true })
    kubectl(['rollout', 'restart', `deployment/${n.deploy}`])
    kubectl(['rollout', 'status', `deployment/${n.deploy}`, `--timeout=${ROLLOUT_TIMEOUT}`])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---- sticky PR comment (best-effort) ----------------------------------------

const COMMENT_MARKER = '<!-- preview-env -->'

function upsertComment(pr, host) {
  const body = [
    COMMENT_MARKER,
    `### 🔎 Preview environment`,
    '',
    `**URL:** http://${host}`,
    '',
    `Isolated per-PR clone of staging (own DB seeded from dev, flow sink disabled).`,
    `Torn down automatically when this PR closes. The QA agent verifies the test plan here.`,
  ].join('\n')
  try {
    const existing = JSON.parse(
      execFileSync('gh', ['pr', 'view', String(pr), '--json', 'comments'], { encoding: 'utf8' }),
    ).comments?.find((c) => c.body?.includes(COMMENT_MARKER))
    if (existing) {
      // gh has no "edit comment by id" for PRs; delete-and-recreate via the API.
      execFileSync('gh', ['api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/comments/${existing.id}`, '-f', `body=${body}`], { stdio: 'ignore' })
    } else {
      execFileSync('gh', ['pr', 'comment', String(pr), '--body', body], { stdio: 'ignore' })
    }
  } catch (err) {
    console.warn(`(sticky comment skipped: ${String(err?.message || err).split('\n')[0]})`)
  }
}

// ---- commands ---------------------------------------------------------------

async function up(pr, imageRef, { comment } = {}) {
  const n = names(pr)

  // Concurrency guard — protect the node from unbounded previews.
  const active = new Set(
    (kubectlJson(['get', 'deploy', '-l', PREVIEW_LABEL]).items ?? [])
      .map((d) => d.metadata.labels?.[PREVIEW_LABEL])
      .filter(Boolean),
  )
  if (!active.has(String(pr)) && active.size >= MAX_PREVIEWS) {
    throw new Error(`preview cap reached (${active.size}/${MAX_PREVIEWS}); close a PR or raise MAX_PREVIEWS`)
  }

  const srcDeploy = kubectlJson(['get', 'deploy', SRC_DEPLOY])
  const srcSvc = kubectlJson(['get', 'svc', SRC_SVC])
  const srcIngress = kubectlJson(['get', 'ingressroute', SRC_INGRESSROUTE])

  console.log(`Provisioning preview ${n.deploy} @ ${imageRef}`)
  apply(buildPvc(pr))
  apply(buildDeployment(pr, imageRef, srcDeploy))
  apply(buildService(pr, srcSvc))
  apply(buildIngressRoute(pr, srcIngress))

  console.log('Seeding series.sqlite from dev…')
  seedDb(pr)

  // Health gate via exec (independent of external DNS/ingress). The readiness
  // probe should already have gated `rollout status`, but retry briefly in case
  // the pod was just recreated.
  let health = ''
  for (let i = 0; i < 10; i++) {
    const pod = podFor(n.deploy)
    try {
      health = kubectl(['exec', pod, '--', 'wget', '-qO-', 'http://localhost:3000/health'], { quiet: true })
      if (health === 'ok') break
    } catch { /* pod not serving yet */ }
    await sleep(3000)
  }
  if (health !== 'ok') throw new Error(`preview /health returned '${health}', expected 'ok'`)

  // Internal URL for the QA agent: the Service ClusterIP, reachable from a
  // cluster node (kube-proxy) with no Cloudflare/TLS/Host-header in the way. The
  // public host goes through the CF-proxied wildcard, which is for humans only.
  const clusterIp = kubectl(['get', 'svc', n.svc, '-o', 'jsonpath={.spec.clusterIP}'], { quiet: true })

  console.log(`\nPreview ready: http://${n.host}  (internal: http://${clusterIp})`)
  console.log(`PREVIEW_URL=http://${n.host}`) // public, for the human comment
  console.log(`PREVIEW_INTERNAL_URL=http://${clusterIp}`) // for the QA agent
  if (comment) upsertComment(pr, n.host)
}

function down(pr) {
  console.log(`Tearing down preview for PR #${pr}`)
  kubectl(['delete', 'deploy,svc,ingressroute,pvc', '-l', `${PREVIEW_LABEL}=${pr}`, '--ignore-not-found'])
}

async function main() {
  const [cmd, prArg, imageRef, ...rest] = process.argv.slice(2)
  const pr = Number(prArg)
  if (!cmd || !Number.isInteger(pr) || pr <= 0) {
    console.error('Usage: preview-env.mjs up <prNumber> <imageRef> [--comment]\n       preview-env.mjs down <prNumber>')
    process.exit(2)
  }
  if (cmd === 'up') {
    if (!imageRef) { console.error('up requires <imageRef>'); process.exit(2) }
    await up(pr, imageRef, { comment: rest.includes('--comment') })
  } else if (cmd === 'down') {
    down(pr)
  } else {
    console.error(`unknown command: ${cmd}`)
    process.exit(2)
  }
}

main().catch((err) => {
  console.error(String(err?.message || err))
  process.exit(1)
})
