import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const COOLDOWN_PATH = process.env.QA_COOLDOWN_PATH || '/var/cache/boop-watch-qa/cooldowns.json'

function loadLedger() {
  try {
    return JSON.parse(readFileSync(COOLDOWN_PATH, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`Could not load ledger from ${COOLDOWN_PATH}:`, err.message)
    return { credentials: {}, updatedAt: new Date().toISOString() }
  }
}

function saveLedger(ledger) {
  try {
    mkdirSync(dirname(COOLDOWN_PATH), { recursive: true })
    writeFileSync(COOLDOWN_PATH, JSON.stringify(ledger, null, 2))
  } catch (err) {
    console.warn(`Could not save ledger to ${COOLDOWN_PATH}:`, err.message)
  }
}

export function parseResetTime(raw) {
  if (!raw) return Date.now() + 3600 * 1000
  
  const match = raw.match(/resets?\s+(\d+):(\d+)(am|pm)\s*\(UTC\)/i)
  if (match) {
    let [ , h, m, ampm ] = match
    let hour = parseInt(h, 10)
    const min = parseInt(m, 10)
    if (ampm.toLowerCase() === 'pm' && hour < 12) hour += 12
    if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0
    
    const now = new Date()
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, min, 0, 0))
    if (d.getTime() < now.getTime()) {
      d.setUTCDate(d.getUTCDate() + 1)
    }
    return d.getTime()
  }
  
  return Date.now() + 3600 * 1000
}

export function filterCredentials(creds) {
  const ledger = loadLedger()
  const now = Date.now()
  return creds.filter(cred => {
    const entry = ledger.credentials[cred.name]
    if (entry && new Date(entry.until).getTime() > now) {
      console.log(`Skipping credential ${cred.name} (cooling down until ${entry.until})`)
      return false
    }
    return true
  })
}

export function areAllCooling(creds) {
  if (creds.length === 0) return false
  return filterCredentials(creds).length === 0
}

export function getEarliestReset(creds) {
  const ledger = loadLedger()
  let earliest = null
  for (const cred of creds) {
    const entry = ledger.credentials[cred.name]
    if (entry) {
      const until = new Date(entry.until).getTime()
      if (!earliest || until < earliest) earliest = until
    }
  }
  return earliest ? new Date(earliest).toISOString() : null
}

export function recordCooldown(credName, rawReason) {
  const ledger = loadLedger()
  const until = new Date(parseResetTime(rawReason)).toISOString()
  ledger.credentials[credName] = { until, raw: rawReason }
  ledger.updatedAt = new Date().toISOString()
  saveLedger(ledger)
  return until
}
