// src/grab.ts
import { chromium } from 'playwright'

const STATE = '.auth.json'

async function main() {
	const browser = await chromium.launch({ headless: false })
	const ctx = await browser.newContext({
		// only load saved auth if it exists
		storageState: await Bun.file(STATE).exists() ? STATE : undefined,
	})
	const page = await ctx.newPage()

	await page.goto('https://moodle.jku.at')

	// pop the inspector — you log in manually, then close the inspector to continue
	await page.pause()

	// save cookies/localStorage so next run is auto
	await ctx.storageState({ path: STATE })
	console.log('✅ auth state saved to', STATE)

	await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })