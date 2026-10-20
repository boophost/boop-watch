#!/usr/bin/env node
/**
 * Repro/regression check for "subtitles break on every episode change until
 * refresh" (JASSUB left bound to a stale <video>).
 *
 *   BASE_URL=https://<preview> WATCH_ID=<episode id with subs> node scripts/verify-subs-episode-change.mjs
 *
 * Optional: PLAYWRIGHT_AUTH_KEY + PLAYWRIGHT_AUTH_JSON seed a localStorage
 * session (see scripts/qa-agent/supabase-session.mjs); SUBS_NEXT_VIA=next|list|both;
 * PLAYWRIGHT_MODULE=<path to playwright/index.mjs> when it is not resolvable
 * from the repo (e.g. only present in the npx cache).
 *
 * Wraps window.JASSUB to record every instance and the <video> it was built
 * for, plays the episode with subs on, changes episode (Next button, then the
 * episode list), and after each change asserts:
 *   1. the newest live JASSUB instance is bound to the page's current <video>
 *   2. that <video> is attached to the DOM
 *   3. a subtitle canvas is attached to the DOM with a non-zero size
 * Exits 1 on any failure.
 */
import { pathToFileURL } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright')

const BASE = (process.env.BASE_URL || '').replace(/\/$/, '')
const WATCH_ID = process.env.WATCH_ID
if (!BASE || !WATCH_ID) { console.error('BASE_URL and WATCH_ID are required'); process.exit(2) }
const via = process.env.SUBS_NEXT_VIA || 'both'

const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
if (process.env.PLAYWRIGHT_AUTH_KEY) {
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), [process.env.PLAYWRIGHT_AUTH_KEY, process.env.PLAYWRIGHT_AUTH_JSON])
}
// Record each JASSUB instance + the video it was constructed with.
await ctx.addInitScript(() => {
  window.__jassub = []
  let real
  Object.defineProperty(window, 'JASSUB', {
    configurable: true,
    get: () => real,
    set(C) {
      if (!C) { real = C; return }
      real = function (opts) {
        const inst = new C(opts)
        const rec = { inst, video: opts.video, destroyed: false }
        window.__jassub.push(rec)
        const d = inst.destroy?.bind(inst)
        if (d) inst.destroy = (...a) => { rec.destroyed = true; return d(...a) }
        return inst
      }
      real.prototype = C.prototype
    },
  })
})
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('pageerror:', e.message))

let failed = 0
async function check(label) {
  await page.waitForSelector('video', { timeout: 30000 })
  await page.waitForTimeout(6000) // let the provider settle + JASSUB build
  const r = await page.evaluate(() => {
    const live = window.__jassub.filter((x) => !x.destroyed)
    const last = live[live.length - 1]
    const cur = document.querySelector('video')
    const canvas = [...document.querySelectorAll('canvas')].find((c) => c.isConnected && c.width > 0 && c.height > 0)
    return {
      instances: window.__jassub.length,
      live: live.length,
      videoIsCurrent: !!last && last.video === cur,
      videoConnected: !!last && last.video.isConnected,
      canvasOk: !!canvas,
    }
  })
  const ok = r.live >= 1 && r.videoIsCurrent && r.videoConnected && r.canvasOk
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, JSON.stringify(r))
  if (!ok) failed++
}

await page.goto(`${BASE}/watch/${encodeURIComponent(WATCH_ID)}`)
await check('initial episode')
if (via === 'next' || via === 'both') {
  const before = page.url()
  await page.getByRole('button', { name: /next/i }).first().click()
  await page.waitForURL((u) => u.toString() !== before, { timeout: 15000 })
  await check('after Next')
}
if (via === 'list' || via === 'both') {
  const before = page.url()
  // Long seasons render .epcell grid buttons (t23); short ones .eprow rows.
  // Skip the current episode and the chase stub, and click a different one.
  const rows = page.locator('.epgrid .epcell:not(.current), .eps-list .eprow:not(.chasing):not(.current)')
  if (!(await rows.count())) { console.log('FAIL episode list: no other episode to click'); failed++ } else {
    await rows.first().click()
  await page.waitForURL((u) => u.toString() !== before, { timeout: 15000 })
  await check('after episode list click')
  }
}
await browser.close()
process.exit(failed ? 1 : 0)
