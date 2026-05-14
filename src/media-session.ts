/**
 * Builds the `Cookie` header for authenticated media.jku.at fetches without pulling in Playwright at runtime:
 * accepts a raw cookie string (`MEDIA_SESSION_COOKIE`) **or** a Playwright `storageState` JSON file (`MEDIA_PLAYWRIGHT_STATE`).
 */
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_BASE = 'https://media.jku.at'

interface PwCookie {
  name?: string
  value?: string
  domain?: string
  path?: string
  expires?: number
}

function mediaHostname(): string {
  const raw = (typeof process !== 'undefined' ? process.env.MEDIA_BASE_URL : '')?.trim() || DEFAULT_BASE
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname
  } catch {
    return new URL(DEFAULT_BASE).hostname
  }
}

function domainMatches(cookieDomain: string, host: string): boolean {
  const d = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain
  return host === d || host.endsWith(`.${d}`)
}

function cookieApplies(cookie: PwCookie, host: string, nowSec: number): boolean {
  const exp = cookie.expires
  if (typeof exp === 'number' && exp > 0 && exp < nowSec) return false
  const dom = cookie.domain
  return typeof dom === 'string' && dom.length > 0 ? domainMatches(dom, host) : false
}

function headerFromPwStorage(json: unknown, host: string): string | undefined {
  if (!json || typeof json !== 'object' || !('cookies' in json)) return undefined
  const cookies = (json as { cookies?: PwCookie[] }).cookies
  if (!Array.isArray(cookies)) return undefined

  const nowSec = Math.floor(Date.now() / 1000)

  /** Last occurrence wins duplicates (closest to browser merge behavior). */
  const byName = new Map<string, string>()
  for (const c of cookies) {
    const n = c.name?.trim()
    if (!n || !cookieApplies(c, host, nowSec)) continue
    const v = typeof c.value === 'string' ? c.value : ''
    byName.set(n, v)
  }
  const header = [...byName.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  return header || undefined
}

export function getMediaCookieHeader(): string | undefined {
  const direct = (typeof process !== 'undefined' ? process.env.MEDIA_SESSION_COOKIE : '')?.trim()
  if (direct) return direct

  const rawPath = typeof process !== 'undefined' ? process.env.MEDIA_PLAYWRIGHT_STATE : ''
  const p = typeof rawPath === 'string' && rawPath.trim() ? path.resolve(rawPath.trim()) : ''
  const host = mediaHostname()

  if (!p) return undefined
  try {
    if (!fs.existsSync(p)) return undefined
    const json = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown
    return headerFromPwStorage(json, host)
  } catch {
    return undefined
  }
}
