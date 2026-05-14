#!/usr/bin/env bun
/**
 * One-time interactive Shibboleth login → writes Playwright `storageState`.
 * Pipe `MEDIA_PLAYWRIGHT_STATE=.cache/jku-media-storage.json` through `.env` so `mediaFetch` replays cookies.
 *
 * Requires: `bun add -d playwright && bunx playwright install chromium`
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { chromium } from 'playwright'

const BASE = ((process.env.MEDIA_BASE_URL || 'https://media.jku.at').trim().replace(/\/+$/, '')
  || 'https://media.jku.at')
const START = (process.env.MEDIA_LOGIN_URL || '').trim() || BASE
const OUT = path.resolve(process.env.MEDIA_PLAYWRIGHT_STATE?.trim() || '.cache/jku-media-storage.json')

await fs.mkdir(path.dirname(OUT), { recursive: true })

console.log(`
[jku-media-login] Opens Chromium → log in via Shibboleth as you normally would.
Then return here and press Enter to save cookies to:

  ${OUT}

Start URL: ${START}
`)

const rl = readline.createInterface({ input, output })

const browser = await chromium.launch({ headless: false })
const ctx = await browser.newContext()
const page = await ctx.newPage()

await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(() => {})

await rl.question('[jku-media-login] Finished logging in & media loads? Press Enter to save session… ')
await rl.close()

await ctx.storageState({ path: OUT })
await browser.close()

console.log(`[jku-media-login] Saved: ${OUT}
Add to .env (do not commit):
  MEDIA_PLAYWRIGHT_STATE=${OUT}
`)
