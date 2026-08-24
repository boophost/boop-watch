#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim()
}

export function classifyVersionBump(baseRef = 'origin/dev') {
  let headVersion, baseVersion
  
  try {
    headVersion = JSON.parse(sh('git', ['show', 'HEAD:package.json'])).version
  } catch (err) {
    headVersion = null
  }
  
  try {
    baseVersion = JSON.parse(sh('git', ['show', `${baseRef}:package.json`])).version
  } catch (err) {
    baseVersion = null
  }
  
  if (!headVersion || !baseVersion) return 'unknown'
  if (headVersion === baseVersion) return 'none'
  
  const [hMaj, hMin] = headVersion.split('.').map(Number)
  const [bMaj, bMin] = baseVersion.split('.').map(Number)
  
  if (hMaj !== bMaj) return 'major'
  if (hMin !== bMin) return 'minor'
  return 'patch'
}

// pathToFileURL, matching gh.mjs: `file://` + a Windows path yields two slashes
// where Node emits three, so the entry guard never fires and the script exits 0
// having done nothing — which reads exactly like a silent success.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseRef = process.argv[2] || 'origin/dev'
  console.log(classifyVersionBump(baseRef))
}
