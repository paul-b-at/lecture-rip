/**
 * media.jku.at series titles look like `2025W334016` or `2026S229054`:
 * `{WS_startYear}W` winter semester, `{SS_calendarYear}S` summer semester (JKU-style label in OpenCast).
 *
 * **Which “current” semester:** Oct–Dec → `YYYYW`; Jan–Feb → previous year `W` (WS runs into February);
 * Mar–Sep → `YYYYS`. Date is taken in **`MEDIA_SEMESTER_TZ`** (default **`Europe/Vienna`**) so CI (UTC) matches JKU / Austria.
 */
function isValidIanaTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date())
    return true
  }
  catch {
    return false
  }
}

function calendarYearMonthInTz(date: Date, timeZone: string): { year: number; month: number } {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
  const [y, mo] = s.split('-').map(Number)
  return { year: y, month: mo }
}

/** OpenCast tag from wall-clock in the configured timezone (JKU-style). */
export function inferOpenCastSemesterFromCalendar(
  date = new Date(),
  timeZone: string,
): string {
  const { year, month } = calendarYearMonthInTz(date, timeZone)
  if (month >= 10) return `${year}W`
  if (month <= 2) return `${year - 1}W`
  return `${year}S`
}

export function resolveAutoJkuMediaSemester(date = new Date()): {
  semester: string
  timeZoneUsed: string
} {
  let tzRequested = typeof process !== 'undefined' ? (process.env.MEDIA_SEMESTER_TZ ?? '').trim() : ''
  if (!tzRequested) tzRequested = 'Europe/Vienna'
  let timeZoneUsed = isValidIanaTimeZone(tzRequested) ? tzRequested : 'UTC'
  if (timeZoneUsed === 'UTC' && tzRequested !== 'UTC' && tzRequested !== '') {
    console.warn(`[semester] Invalid MEDIA_SEMESTER_TZ «${tzRequested}» → using UTC`)
  }
  return {
    semester: inferOpenCastSemesterFromCalendar(date, timeZoneUsed),
    timeZoneUsed,
  }
}

/**
 * Resolved anchor for LU-only pairing: explicit **`MEDIA_SEMESTER`** / `YYYY[SW]` wins; `auto`/empty runs JKU calendar in **`MEDIA_SEMESTER_TZ`**.
 */
export function semesterAnchorForPipeline(now = new Date()): {
  semester: string
  source: 'env' | 'auto'
  timeZoneUsed?: string
} {
  const raw = typeof process !== 'undefined' ? (process.env.MEDIA_SEMESTER ?? '').trim() : ''
  const v = /^auto$/i.test(raw) ? '' : raw
  const ex = v.match(/^(\d{4})([SsWw])$/)
  if (ex) {
    return { semester: `${ex[1]}${ex[2].toUpperCase()}`, source: 'env' }
  }
  if (v.length > 0) {
    console.warn(`[semester] MEDIA_SEMESTER «${v}» is not YYYY[SW]; falling back to calendar`)
  }
  const { semester, timeZoneUsed } = resolveAutoJkuMediaSemester(now)
  return { semester, source: 'auto', timeZoneUsed }
}

/** @deprecated alias — use `semesterAnchorForPipeline().semester` or `resolveAutoJkuMediaSemester` */
export function defaultJkuMediaSemester(date = new Date()): string {
  return resolveAutoJkuMediaSemester(date).semester
}

/**
 * When **Media Course ID** is LU-only, search uses `{semester}{LU}` (`2026S344090`).
 * OpenCast titles often lag the calendar (e.g. SS study period still lists `2025W…`).
 * Dedup semesters to try when LU-only anchors disagree with OpenCast; **preference** uses `anchorSem` from semester discovery.
 */
export function luOnlyDiscoverySemestersInOrder(anchorSem: string): string[] {
  const m = anchorSem.trim().match(/^(\d{4})([SsWw])$/)
  if (!m) return [anchorSem.trim()].filter(Boolean)

  const y = Number(m[1])
  const west = m[2].toUpperCase() === 'W'
  const cand: string[] =
    west
      ? [`${y}W`, `${y}S`, `${y + 1}S`, `${y - 1}W`]
      : [`${y}S`, `${y - 1}W`, `${y}W`, `${y - 1}S`]

  const seen = new Set<string>()
  const out: string[] = []
  for (const t of cand) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out.length > 0 ? out : [`${y}${west ? 'W' : 'S'}`]
}
