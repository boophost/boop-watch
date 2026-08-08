// Cutover audit: for every managed setting, where does its value come from and
// what is it? Secrets are reported as set/unset only.
const jwt = require('/app/node_modules/jsonwebtoken')
const email = (process.env.ADMIN_EMAILS || '').split(',')[0].trim()
const t = jwt.sign({ username: email, email }, process.env.JWT_SECRET, { expiresIn: '10m' })
;(async () => {
  const r = await fetch('http://localhost:3000/api/config', { headers: { Authorization: 'Bearer ' + t } })
  const j = await r.json()
  const rows = j.config
  const bySource = { env: [], database: [], default: [] }
  for (const c of rows) bySource[c.source].push(c)
  console.log('CONFIG_KEY usable:', j.configKeyConfigured)
  console.log('counts:', Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, v.length])))
  console.log('')
  console.log('ENV-OWNED (these are what the cutover moves):')
  for (const c of bySource.env) {
    const shown = c.secret ? (c.isSet ? '<set>' : '<EMPTY>') : JSON.stringify(c.value)
    console.log(`  ${c.secret ? 'S' : ' '} ${c.key.padEnd(28)} ${shown}`)
  }
  console.log('')
  console.log('DEFAULT (unset everywhere — set these if they matter):')
  for (const c of bySource.default) {
    console.log(`  ${c.secret ? 'S' : ' '} ${c.key.padEnd(28)} default=${JSON.stringify(c.default ?? '')}`)
  }
  if (bySource.database.length) {
    console.log('')
    console.log('ALREADY IN THE DATABASE:')
    for (const c of bySource.database) console.log(`  ${c.key}`)
  }
})()
