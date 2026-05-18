import { getMediaCookieHeader } from './media-session'

/** OpenCast engage search JSON on JKU media. */
export const DEFAULT_MEDIA_BASE = 'https://media.jku.at'

/** Missing GitHub Secrets inject `ENV=""` — `??` does not fall back; treat empty / whitespace as unset. */
export function normalizeMediaBase(raw?: string | null): string {
  const t = typeof raw === 'string' ? raw.trim() : ''
  return (t ? t : DEFAULT_MEDIA_BASE).replace(/\/+$/, '')
}

/** Same-origin fetches against `media.jku.at`; cookie from `#MEDIA_SESSION_COOKIE` or Playwright `#MEDIA_PLAYWRIGHT_STATE`. */
export function mediaFetch(url: string): Promise<Response> {
  const ck = getMediaCookieHeader()
  return ck ? fetch(url, { headers: { Cookie: ck } }) : fetch(url)
}

interface SeriesHit {
  id: string
  title: string
}

interface TrackLike {
  mimetype?: string
  tags?: { tag?: string[] | string }
  url?: string
  size?: number
}

function normalizeTags(t: TrackLike): string[] {
  const raw = t.tags?.tag
  if (raw == null) return []
  return (Array.isArray(raw) ? raw : [raw]).map((x) => String(x).toLowerCase())
}

function normalizeCourseDigits(raw: string): string {
  return raw.replace(/[^\d]/g, '').trim()
}

/**
 * LU digits encoded after `{semester}` in OpenCast series titles (`2026S344022` → `344022`).
 * If Notion formulas concatenate `{year}+{LU}`, digits become e.g. `2026344022`; strip one leading `{YYYY}` matching the semester calendar year.
 */
export function luDigitsForSemester(raw: string, semester: string): string {
  const digitsOnly = normalizeCourseDigits(raw)
  if (!digitsOnly) return ''

  const sm = semester.trim().match(/^(\d{4})([Ws])$/i)
  const y = sm?.[1]
  if (y && digitsOnly.startsWith(y) && digitsOnly.length >= y.length + 4) {
    const peeled = digitsOnly.slice(y.length)
    if (peeled.length >= 3 && peeled.length <= 12) return peeled
  }

  return digitsOnly
}

/**
 * Parses **Media Course ID** from Notion:
 * - **Full OpenCast series name** (`2026S344090`, `2025W338002/4`) — semester+L U come from this string (overrides calendar).
 * - **LU digits only** (`344090`) — paired with `{fallbackSemester}` from `.env`/calendar.
 */
export function parseMediaCourseKey(
  mediaCourseId: string,
  fallbackSemester: string,
): { semester: string; lu: string; fullSeriesTitle: string | null } {
  const trimmed = mediaCourseId.trim()
  const dm = trimmed.match(/^(\d{4})([Ws])(.+)$/i)

  if (dm) {
    const semesterFromTitle = `${dm[1]}${dm[2].toUpperCase()}`
    const firstSeg = dm[3].split('/')[0]?.trim() ?? ''
    const lu = normalizeCourseDigits(firstSeg)
    if (lu.length >= 3 && lu.length <= 12) {
      return { semester: semesterFromTitle, lu, fullSeriesTitle: trimmed }
    }
  }

  const lu = luDigitsForSemester(trimmed, fallbackSemester)
  return {
    semester: fallbackSemester,
    lu,
    fullSeriesTitle: null,
  }
}

/** Exported for filtering episode payloads after `/search/episode.json`. */
export function seriesTitlesMatch(seriestitle: string, semester: string, courseDigits: string): boolean {
  const t = seriestitle.trim()
  const prefix = `${semester}${courseDigits}`
  if (t === prefix) return true
  if (t.startsWith(prefix + '/') || t.startsWith(prefix + '-') || t.startsWith(prefix + ' ')) return true
  for (const part of t.split(/[/\s]+/)) {
    if (part === prefix) return true
  }
  return false
}

function parseUuid(raw: string | undefined): string | null {
  if (!raw?.trim()) return null
  const m = raw.trim().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  return m ? m[0].toLowerCase() : null
}

/** Treat any UUID inside an Engage/Paella/watch URL as a **mediapackage** hint (Paella calls `/search/episode.json?id=…`). */
export function extractEpisodeHintUuid(text: string): string | null {
  const t = text.trim()
  if (!/[./?#]/.test(t) && !/\b(epFrom|episode|watch\.html)/i.test(t)) return null
  return parseUuid(t)
}

async function fetchSeriesBatchByQuery(base: string, qRaw: string): Promise<SeriesHit[]> {
  const q = qRaw.trim()
  if (!q) return []

  const u = new URL(`${base}/search/series.json`)
  u.searchParams.set('sign', 'false')
  u.searchParams.set('limit', '50')
  u.searchParams.set('offset', '0')
  u.searchParams.set('q', q)
  const res = await mediaFetch(u.href)
  if (!res.ok) throw new Error(`series search q=… ${res.status}`)
  const data = (await res.json()) as { result?: any[] }

  const out: SeriesHit[] = []
  for (const row of data.result ?? []) {
    const title = Array.isArray(row?.dc?.title) ? String(row.dc.title[0] ?? '').trim() : ''
    const id = Array.isArray(row?.dc?.identifier) ? String(row.dc.identifier[0] ?? '').trim() : ''
    if (!id.includes('-') || !title) continue
    out.push({ id, title })
  }
  return out
}

function mediaResolveLooseLuDefault(): boolean {
  const t = typeof process !== 'undefined' ? (process.env.MEDIA_RESOLVE_LOOSE_LU ?? '').trim().toLowerCase() : ''
  return t === '1' || t === 'true' || t === 'yes'
}

export async function resolveSeriesForSubject(opts: {
  baseUrl?: string
  semester: string
  mediaCourseId: string
  mediaSeriesIdHint?: string
  /** When search returns unrelated rows, allow “unique LU substring” heuristic (risk: wrong semester). Default from `MEDIA_RESOLVE_LOOSE_LU`. */
  allowLooseLu?: boolean
}): Promise<SeriesHit | null> {
  const base = normalizeMediaBase(opts.baseUrl)
  const pinned = parseUuid(opts.mediaSeriesIdHint)
  if (pinned) return { id: pinned, title: '(pinned Media Series ID)' }

  /** Engage/play URLs bootstrap via `/search/episode.json?id=` in `discover`, not LU parsing here. */
  if (extractEpisodeHintUuid(opts.mediaCourseId.trim())) return null

  const key = parseMediaCourseKey(opts.mediaCourseId, opts.semester)
  const { lu, semester: semEff, fullSeriesTitle } = key

  if (!lu || lu.length < 3) return null

  const pref = `${semEff}${lu}`
  /** Full OpenCast titles are explicit — never widen with substring heuristics. */
  const allowLoose = fullSeriesTitle == null && (opts.allowLooseLu ?? mediaResolveLooseLuDefault())

  /** Prefer lucene title query (`q=`); `/search/` supports plain tokens like `2026S229054` reliably. */
  const fromQueries: SeriesHit[] = []
  const seen = new Set<string>()
  const pushDedup = (rows: SeriesHit[]) => {
    for (const h of rows) {
      if (seen.has(h.id)) continue
      seen.add(h.id)
      fromQueries.push(h)
    }
  }

  if (fullSeriesTitle) pushDedup(await fetchSeriesBatchByQuery(base, fullSeriesTitle.trim()))
  pushDedup(await fetchSeriesBatchByQuery(base, pref))

  const exactFromQ =
    fullSeriesTitle != null
      ? fromQueries.find((h) => h.title === fullSeriesTitle.trim()) ?? null
      : null

  const matchFromQ =
    exactFromQ
    ?? fromQueries.find((h) => seriesTitlesMatch(h.title.trim(), semEff, lu))
    ?? null

  if (!matchFromQ && allowLoose && fromQueries.length > 0) {
    /** Unique substring match — can pick wrong LU/semester; opt-in via `MEDIA_RESOLVE_LOOSE_LU`. */
    const uniqueLu = fromQueries.filter((h) => h.title.includes(lu))
    if (uniqueLu.length === 1) {
      console.warn(`[resolveSeries] Loose LU substring match (${lu}): ${uniqueLu[0].title}`)
      return uniqueLu[0]
    }
  }

  if (matchFromQ) return matchFromQ

  /** `sname` is not “LU substring” on JKU Opencast; only use as fallback and filter strictly. */
  const all = await fetchAllSeriesMatchingSname(base, lu)
  const filtered = all.filter((h) => seriesTitlesMatch(h.title.trim(), semEff, lu))
  const exact =
    fullSeriesTitle != null ? filtered.find((h) => h.title === fullSeriesTitle.trim()) ?? null : null
  const resolved = exact ?? filtered.find((h) => seriesTitlesMatch(h.title.trim(), semEff, lu)) ?? null
  if (resolved) return resolved

  if (all.length > 0 && allowLoose) {
    const uniqueLuAll = all.filter((h) => h.title.includes(lu))
    if (uniqueLuAll.length === 1) {
      console.warn(`[resolveSeries] Loose LU via sname index (${lu}): ${uniqueLuAll[0].title}`)
      return uniqueLuAll[0]
    }
  }

  return null
}

async function fetchAllSeriesMatchingSname(base: string, sname: string): Promise<SeriesHit[]> {
  const byId = new Map<string, SeriesHit>()
  let offset = 0
  const limit = 50

  while (offset < 10_000) {
    const u = new URL(`${base}/search/series.json`)
    u.searchParams.set('sname', sname)
    u.searchParams.set('limit', String(limit))
    u.searchParams.set('offset', String(offset))
    const res = await mediaFetch(u.href)
    if (!res.ok) throw new Error(`series search ${res.status}`)
    const data = (await res.json()) as { result?: any[]; total?: number }

    const batchRaw = data.result ?? []
    for (const row of batchRaw) {
      const title = Array.isArray(row?.dc?.title) ? String(row.dc.title[0] ?? '').trim() : ''
      const id = Array.isArray(row?.dc?.identifier) ? String(row.dc.identifier[0] ?? '').trim() : ''
      if (!id.includes('-') || !title) continue
      byId.set(id, { id, title })
    }

    offset += batchRaw.length
    const total = typeof data.total === 'number' ? data.total : offset
    if (batchRaw.length === 0 || offset >= total) break
  }

  return [...byId.values()]
}

export interface MediaEpisode {
  id: string
  title: string
  seriestitle: string
  seriesId: string
  mp4Url: string
}

function pickMp4(tracks: TrackLike[]): string | null {
  const cand = tracks.filter(
    (t) => typeof t.url === 'string' && t.url.startsWith('http') && String(t.mimetype ?? '').includes('mp4'),
  )

  const rank = (t: TrackLike) => {
    const tags = normalizeTags(t)
    let score = 0
    if (tags.some((g) => g.includes('engage-download'))) score += 100
    if (tags.some((g) => g.includes('720p'))) score += 40
    if (tags.some((g) => g.includes('480p'))) score += 30
    if (tags.some((g) => g.includes('1080p'))) score += 10
    const size = typeof t.size === 'number' ? t.size : 0
    return score * 1e15 - size
  }

  if (cand.length === 0) return null
  cand.sort((a, b) => rank(b) - rank(a))
  return cand[0]?.url ?? null
}

function coerceTracks(media: unknown): TrackLike[] {
  const raw = media as { track?: TrackLike | TrackLike[] } | null | undefined
  const t = raw?.track
  if (!t) return []
  return Array.isArray(t) ? t : [t]
}

function parseEpisodeMediapackageRow(row: unknown, fallbackSeriesId = ''): MediaEpisode | null {
  const mp = (row as { mediapackage?: Record<string, unknown> })?.mediapackage
  if (!mp?.id) return null
  const tracks = coerceTracks(mp.media)
  const url = pickMp4(tracks)
  if (!url) return null
  const seriesId = String(mp.series ?? fallbackSeriesId)
  return {
    id: String(mp.id),
    title: String(mp.title ?? 'Untitled'),
    seriestitle: String(mp.seriestitle ?? ''),
    seriesId: seriesId.includes('-') ? seriesId : fallbackSeriesId,
    mp4Url: url,
  }
}

async function fetchEpisodeSearchPages(
  base: string,
  params: Record<string, string>,
  maxResults = 500,
): Promise<MediaEpisode[]> {
  const episodes: MediaEpisode[] = []
  const seen = new Set<string>()
  let offset = 0
  const limit = 50

  while (offset < maxResults) {
    const u = new URL(`${base}/search/episode.json`)
    u.searchParams.set('limit', String(limit))
    u.searchParams.set('offset', String(offset))
    for (const [k, v] of Object.entries(params))
      u.searchParams.set(k, v)

    const res = await mediaFetch(u.href)
    if (!res.ok)
      throw new Error(`episode search ${res.status}: ${await res.text().then((txt) => txt.slice(0, 120))}`)
    const data = (await res.json()) as { result?: unknown[]; total?: number }

    const batch = data.result ?? []
    for (const row of batch) {
      const ep = parseEpisodeMediapackageRow(row, params.sid ?? '')
      if (!ep || seen.has(ep.id)) continue
      seen.add(ep.id)
      episodes.push(ep)
    }

    offset += batch.length
    const total = typeof data.total === 'number' ? data.total : offset
    if (batch.length === 0 || offset >= total || episodes.length >= maxResults) break
  }

  return episodes.sort((a, b) => b.id.localeCompare(a.id))
}

export async function fetchEpisodesForSeries(baseUrl: string | undefined, seriesId: string): Promise<MediaEpisode[]> {
  const base = normalizeMediaBase(baseUrl)
  return fetchEpisodeSearchPages(base, { sid: seriesId })
}

/** Discover episodes by free-text query when they are not grouped under one OpenCast series. */
export async function fetchEpisodesByQuery(
  baseUrl: string | undefined,
  query: string,
  maxResults = 500,
): Promise<MediaEpisode[]> {
  const q = query.trim()
  if (!q) return []
  const base = normalizeMediaBase(baseUrl)
  return fetchEpisodeSearchPages(base, { q }, maxResults)
}

/**
 * Loads one mediapackage by id (same call Paella uses). Returns null if ACL hides it from `/search/` (try `MEDIA_SESSION_COOKIE`).
 */
export async function fetchEpisodeMediapackageById(
  baseUrl: string | undefined,
  mediapackageId: string,
): Promise<{ episode: MediaEpisode; seriesId: string; seriestitle: string } | null> {
  const base = normalizeMediaBase(baseUrl)
  const u = new URL(`${base}/search/episode.json`)
  u.searchParams.set('limit', '5')
  u.searchParams.set('offset', '0')
  u.searchParams.set('id', mediapackageId)
  const res = await mediaFetch(u.href)
  if (!res.ok) return null
  const data = (await res.json()) as { result?: any[] }

  for (const row of data.result ?? []) {
    const ep = parseEpisodeMediapackageRow(row)
    if (!ep || ep.id.toLowerCase() !== mediapackageId.toLowerCase()) continue
    if (!ep.seriesId.includes('-')) continue
    return { episode: ep, seriesId: ep.seriesId, seriestitle: ep.seriestitle }
  }
  return null
}

export function lecturePageUrl(episodeId: string, baseUrl?: string): string {
  const base = normalizeMediaBase(baseUrl)
  return `${base}/play/${episodeId}`
}

export { normalizeCourseDigits }
