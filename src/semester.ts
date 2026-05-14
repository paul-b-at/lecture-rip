/**
 * media.jku.at series titles look like `2025W334016` or `2026S229054`:
 * `{WS_startYear}W` winter semester, `{SS_calendarYear}S` summer semester (JKU-style label in OpenCast).
 */
export function defaultJkuMediaSemester(date = new Date()): string {
  const year = date.getFullYear()
  const month = date.getMonth() + 1 // 1–12
  if (month >= 10) return `${year}W`
  if (month <= 2) return `${year - 1}W`
  return `${year}S`
}

/**
 * When **Media Course ID** is LU-only, search uses `{semester}{LU}` (`2026S344090`).
 * OpenCast titles often lag the calendar (e.g. SS study period still lists `2025W…`).
 * Try semesters in this order until `/search/` finds a matching series — first match wins.
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
