/** Shared Moodle session adapter. Keep this file identical in both sync repositories. */
import { chromium, type BrowserContext, type Page } from 'playwright'

export const MOODLE = 'https://moodle.jku.at'
const MEDIA_HOSTS = new Set(['media.jku.at', 'stream.jku.at'])
export interface MoodleCourse { id: number; fullname: string; shortname: string; viewurl?: string }
export interface MoodleEvent {
  id: number; name: string; activityname?: string; modulename: string; eventtype: string
  timestart: number; timeduration?: number; timesort?: number; instance?: number
  url?: string; action?: { url?: string }; course?: MoodleCourse
}
export interface PageParts {
  activities: Array<{ title: string; url: string }>
  episodes: Array<{ title: string; url: string }>
  launches: string[]
  episodeScript: string | null
}

export function currentSemester(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Vienna', year: 'numeric', month: 'numeric' }).formatToParts(now)
  const year = Number(parts.find(p => p.type === 'year')!.value)
  const month = Number(parts.find(p => p.type === 'month')!.value)
  return `${month < 3 ? year - 1 : year}${month >= 10 || month < 3 ? 'W' : 'S'}`
}

export function normalizeCourseNumber(raw: string): string { return raw.replace(/[.\s-]/g, '').toUpperCase() }
/** Handles 340.320-33, 344.021/2/3/.../W01, and mixed 357.260/531940/... keys. */
export function courseNumbers(course: Pick<MoodleCourse, 'fullname' | 'shortname'>): string[] {
  const raw = (course.fullname.split(',')[0] || course.shortname.replace(/^(?:M-)?\d{4}[WS]/i, '')).trim()
  const pieces = raw.split('/')
  const first = normalizeCourseNumber(pieces[0]!.split('-')[0]!)
  const prefix = first.slice(0, 3)
  let previous = first.slice(3)
  const out = new Set<string>()
  for (const [i, piece] of pieces.entries()) {
    const [left, right] = piece.trim().split('-')
    const full = i === 0 || left!.replace(/\./g, '').length >= 6
      ? normalizeCourseNumber(left!)
      : prefix + (/^[A-Z]/i.test(left!) ? left!.toUpperCase() : previous.slice(0, Math.max(0, 3 - left!.length)) + left!)
    out.add(full)
    previous = full.slice(3)
    if (right && /^\d+$/.test(right) && /^\d+$/.test(full)) {
      const end = Number(full.slice(0, -right.length) + right)
      const begin = Number(full)
      if (end >= begin && end - begin <= 100) for (let n = begin + 1; n <= end; n++) out.add(String(n))
    }
  }
  return [...out]
}

/** Extract JSON, never eval instructor-supplied JavaScript. */
export function parseEpisodeScript(script: string | null): any | null {
  if (!script) return null
  const marker = /window\.episode\s*=\s*/.exec(script)
  if (!marker) return null
  const start = script.indexOf('{', marker.index + marker[0].length)
  if (start < 0) return null
  let depth = 0, quoted = false, escaped = false
  for (let i = start; i < script.length; i++) {
    const ch = script[i]!
    if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue }
    if (ch === '"') quoted = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return JSON.parse(script.slice(start, i + 1))
  }
  throw new Error('Truncated Moodle episode metadata')
}

export function collectCalendarEvents(data: unknown): MoodleEvent[] {
  const out = new Map<number, MoodleEvent>()
  const visit = (n: any) => {
    if (!n || typeof n !== 'object') return
    if (Number.isInteger(n.id) && n.modulename && n.eventtype && Number.isFinite(n.timestart)) out.set(n.id, n)
    for (const v of Object.values(n)) if (v && typeof v === 'object') visit(v)
  }
  visit(data)
  return [...out.values()]
}

export class MoodleSession {
  constructor(readonly page: Page) {}
  get context(): BrowserContext { return this.page.context() }

  static async open(context: BrowserContext): Promise<MoodleSession> {
    const page = await context.newPage()
    try {
      await page.goto(`${MOODLE}/my/`, { waitUntil: 'domcontentloaded' })
      const ready = () => page.evaluate(() => Boolean((globalThis as any).M?.cfg?.sesskey && ((globalThis as any).M?.cfg?.userId ?? (globalThis as any).M?.cfg?.userid ?? 0) > 0))
      if (!page.url().startsWith(MOODLE) || !(await ready())) {
        await page.goto(`${MOODLE}/login/index.php`, { waitUntil: 'domcontentloaded' })
        const username = page.locator('#username, input[name="j_username"]').first()
        await username.waitFor({ state: 'visible', timeout: 30_000 })
        const user = process.env.JKU_USER?.trim(), pass = process.env.JKU_PASS
        if (!user || !pass) throw new Error('Moodle sign-in requires JKU_USER and JKU_PASS; provision repository secrets, never commit credentials')
        await username.fill(user)
        await page.locator('#password, input[name="j_password"]').first().fill(pass)
        const noRemember = page.locator('#donotcache')
        if (await noRemember.isVisible()) await noRemember.uncheck()
        await page.locator('button[name="_eventId_proceed"], button[type="submit"], input[type="submit"]').first().click()
        await page.waitForURL(`${MOODLE}/**`, { timeout: 60_000, waitUntil: 'domcontentloaded' })
      }
      await page.waitForFunction(() => Boolean((globalThis as any).M?.cfg?.sesskey && ((globalThis as any).M?.cfg?.userId ?? (globalThis as any).M?.cfg?.userid ?? 0) > 0), { timeout: 30_000 })
      return new MoodleSession(page)
    } catch {
      await page.close()
      // Do not include Playwright errors: they can contain SAML/session-bearing URLs.
      throw new Error('Moodle sign-in failed: verify JKU secrets and any MFA requirement. No fallback to an empty success; security requirements must not be bypassed.')
    }
  }

  async ajax<T>(method: string, args: Record<string, unknown>): Promise<T> {
    return this.page.evaluate(async ({ method, args }) => {
      const g = globalThis as any
      if (!g.M?.cfg?.sesskey || !(g.M?.cfg?.userId ?? g.M?.cfg?.userid)) throw new Error('Moodle session expired')
      const r = await fetch('/lib/ajax/service.php?' + new URLSearchParams({ sesskey: g.M.cfg.sesskey, info: method }), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ index: 0, methodname: method, args }]), signal: AbortSignal.timeout(30_000),
      })
      if (!r.ok) throw new Error(`Moodle AJAX HTTP ${r.status}`)
      const [result] = await r.json() as any[]
      if (!result || result.error) throw new Error(`Moodle AJAX ${method} failed (${result?.exception?.errorcode || 'invalid response'})`)
      return result.data
    }, { method, args }) as Promise<T>
  }

  async courses(): Promise<MoodleCourse[]> {
    const out = new Map<number, MoodleCourse>()
    let offset = 0
    while (true) {
      const data = await this.ajax<{ courses: MoodleCourse[]; nextoffset: number }>('core_course_get_enrolled_courses_by_timeline_classification', { classification: 'all', limit: 50, offset, sort: 'fullname' })
      for (const c of data.courses) out.set(c.id, c)
      if (data.courses.length < 50) break
      if (data.nextoffset <= offset) throw new Error('Moodle course pagination did not advance')
      offset = data.nextoffset
    }
    return [...out.values()]
  }

  async actionEvents(from: number, to: number): Promise<MoodleEvent[]> {
    const out = new Map<number, MoodleEvent>()
    let aftereventid = 0
    while (true) {
      const data = await this.ajax<{ events: MoodleEvent[]; lastid: number }>('core_calendar_get_action_events_by_timesort', { timesortfrom: from, timesortto: to, aftereventid, limitnum: 50 })
      for (const e of data.events) out.set(e.id, e)
      if (data.events.length < 50) break
      if (!data.lastid || data.lastid === aftereventid) throw new Error('Moodle task pagination did not advance')
      aftereventid = data.lastid
    }
    return [...out.values()]
  }

  async monthlyEvents(courseId: number, year: number, month: number): Promise<MoodleEvent[]> {
    return collectCalendarEvents(await this.ajax('core_calendar_get_calendar_monthly_view', { year, month, courseid: courseId, includenavigation: false, mini: false }))
  }

  async parts(url: string): Promise<PageParts> {
    if (new URL(url).origin !== MOODLE) throw new Error('Refusing non-Moodle course URL')
    return this.page.evaluate(async url => {
      const g = globalThis as any
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!r.ok || new URL(r.url).origin !== 'https://moodle.jku.at') throw new Error('Moodle resource unavailable or login expired')
      const d = new g.DOMParser().parseFromString(await r.text(), 'text/html')
      if (!d.querySelector('#region-main')) throw new Error('Unexpected Moodle resource response')
      const main = d.querySelector('#region-main')
      const activities = [...d.querySelectorAll('.activity a[href]')].filter((a: any) => /\/mod\/opencast\/view\.php/.test(a.href)).map((a: any) => ({ title: a.textContent.trim().replace(/\s+/g, ' '), url: a.href }))
      const episodes = [...main.querySelectorAll('a[href]')].filter((a: any) => { try { return new URL(a.href).searchParams.has('e') && /\/mod\/opencast\/view\.php/.test(a.href) } catch { return false } }).map((a: any) => ({ title: a.textContent.trim().replace(/\s+/g, ' '), url: a.href }))
      const launches = [...d.querySelectorAll('iframe[src]')].map((f: any) => f.src).filter((s: string) => s.includes('/filter/opencast/ltilaunch.php'))
      const episodeScript = [...d.querySelectorAll('script')].map((s: any) => s.textContent).find((s: string) => /window\.episode\s*=/.test(s)) ?? null
      return { activities, episodes, launches, episodeScript }
    }, url)
  }

  /** Establish Moodle LTI access in the same browser context; never persist or log launch/session URLs. */
  async authorizePlayer(url: string): Promise<any> {
    const p = await this.context.newPage()
    try {
      if (new URL(url).origin !== MOODLE) throw new Error('Invalid Moodle player URL')
      await p.goto(url, { waitUntil: 'domcontentloaded' })
      const iframe = p.locator('iframe[src*="/filter/opencast/ltilaunch.php"]').first()
      await iframe.waitFor({ state: 'attached', timeout: 30_000 })
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const frame = p.frames().find(f => { try { return MEDIA_HOSTS.has(new URL(f.url()).hostname) } catch { return false } })
        if (frame) {
          await frame.waitForLoadState('domcontentloaded')
          // Some Moodle LTI launches allow playback but do not grant global /search/ visibility.
          // Moodle itself provides the authorized window.episode payload in those cases.
          const embedded = await p.evaluate(() => (globalThis as any).episode ?? null)
          if (embedded?.metadata?.id && embedded.streams?.length) return embedded
          return await frame.evaluate(async () => {
            const g = globalThis as any
            if (g.episode?.metadata?.id) return g.episode
            const id = new URL(g.location.href).searchParams.get('id')
            if (!id) throw new Error('Player has no episode ID')
            const r = await fetch('/search/episode.json?' + new URLSearchParams({ id, limit: '5', offset: '0' }), { signal: AbortSignal.timeout(30_000) })
            if (!r.ok) throw new Error('Authenticated episode lookup failed')
            const j: any = await r.json()
            const m = j.result?.[0]?.mediapackage
            if (!m) throw new Error('Episode unavailable after Moodle LTI launch')
            const tracks = Array.isArray(m.media?.track) ? m.media.track : [m.media?.track].filter(Boolean)
            return { metadata: { id: m.id, title: m.title, duration: Number(m.duration) / 1000 }, streams: tracks.filter((t: any) => t.mimetype === 'video/mp4').map((t: any) => ({ content: t.type?.split('/')[0], sources: { mp4: [{ src: t.url, mimetype: t.mimetype }] } })) }
          })
        }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      throw new Error('Player authorization timed out')
    } catch {
      throw new Error('Moodle recording authorization failed; verify LTI access and session/MFA')
    } finally { await p.close() }
  }

  /** Stream via native fetch; attach only cookies applicable to each validated JKU media URL. */
  fetchMedia = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    for (let redirects = 0; redirects < 6; redirects++) {
      const u = new URL(url)
      if (u.protocol !== 'https:' || !MEDIA_HOSTS.has(u.hostname)) throw new Error('Refusing media download outside approved JKU hosts')
      const cookies = await this.context.cookies(url)
      const headers = new Headers(init?.headers)
      headers.delete('Cookie')
      if (cookies.length) headers.set('Cookie', cookies.map(c => `${c.name}=${c.value}`).join('; '))
      const response = await fetch(url, { ...init, headers, redirect: 'manual', signal: init?.signal ?? AbortSignal.timeout(120_000) })
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('Invalid media redirect')
      url = new URL(location, url).href
    }
    throw new Error('Too many media redirects')
  }
}

export async function launchMoodleBrowser(): Promise<BrowserContext> {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  context.on('close', () => { void browser.close() })
  return context
}
