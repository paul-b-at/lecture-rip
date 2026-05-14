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
