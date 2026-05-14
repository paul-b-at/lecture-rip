import type { Lecture, Subject } from './types'
import {
  normalizeMediaBase,
  extractEpisodeHintUuid,
  fetchEpisodeMediapackageById,
  fetchEpisodesForSeries,
  lecturePageUrl,
  parseMediaCourseKey,
  resolveSeriesForSubject,
  seriesTitlesMatch,
} from './media-jku'
import { defaultJkuMediaSemester, luOnlyDiscoverySemestersInOrder } from './semester'

export interface DiscoveredLecture {
  id: string
  title: string
  courseId: string
  moodleUrl: string
  opencastUrl: string
  glossary?: string
  durationSeconds?: number
}

function parseUuid(raw: string): string | null {
  if (!raw?.trim()) return null
  const m = raw.trim().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  return m ? m[0].toLowerCase() : null
}

/**
 * Discover lectures via media.jku.at (`/search/series.json`, `/search/episode.json`).
 * Each Notion Subject needs **Media Course ID** (series name like `2026S344090`, LU digits only, or Engage/play URL),
 * and/or **Media Series ID** (OpenCast UUID). Anonymous discovery may lag ACL; **`MEDIA_SESSION_COOKIE`** aligns with Paella.
 * Calendar `MEDIA_SEMESTER` is ignored when the series name embeds `YYYYW|YYYYS`.
 * LU-only rows try **neighbor semesters** in order (`luOnlyDiscoverySemestersInOrder`) until search hits a matching series title.
 */
export async function discoverLecturesFromMedia(
  subjects: Subject[],
  existingLectures: Map<string, Lecture>,
  opts: {
    courseFilterRegex?: string
    baseUrl?: string
    semesterOverride?: string | null
  },
): Promise<DiscoveredLecture[]> {
  const filterRegex = opts.courseFilterRegex ? new RegExp(opts.courseFilterRegex, 'i') : null
  const base = normalizeMediaBase(opts.baseUrl ?? process.env.MEDIA_BASE_URL)

  let semester = (opts.semesterOverride ?? '').trim() || (process.env.MEDIA_SEMESTER ?? '').trim()

  if (/^auto$/i.test(semester)) semester = ''
  if (!semester) semester = defaultJkuMediaSemester()

  console.log(`[discover] media.jku.at  semester=${semester}  base=${base}`)

  const discovered: DiscoveredLecture[] = []

  for (const subject of subjects) {
    if (filterRegex && !filterRegex.test(subject.name)) continue

    console.log(`[discover] Subject: ${subject.name}`)

    if (!subject.mediaCourseId.trim() && !subject.mediaSeriesId.trim()) {
      console.warn(`[discover]   Skip: add "Media Course ID" or "Media Series ID" in Notion`)
      continue
    }

    const pinned = parseUuid(subject.mediaSeriesId.trim())
    const courseStr = subject.mediaCourseId.trim()
    const episodeHintUuid = !pinned ? extractEpisodeHintUuid(courseStr) : null

    let filterKey: ReturnType<typeof parseMediaCourseKey> =
      episodeHintUuid
        ? { semester, lu: '', fullSeriesTitle: null }
        : parseMediaCourseKey(courseStr, semester)

    if (
      !pinned
      && !episodeHintUuid
      && (!filterKey.lu || filterKey.lu.length < 3)
    ) {
      console.warn(`[discover]   Skip: set "Media Course ID" (series name / LU digits) or "Media Series ID" (UUID)`)
      continue
    }

    if (!pinned && episodeHintUuid) {
      console.log(`[discover]   OpenCast bootstrap  mediapackage=${episodeHintUuid}  (+ series via episode)`)
    } else if (!pinned) {
      console.log(
        `[discover]   OpenCast key  semester=${filterKey.semester}  lu=${filterKey.lu}`
          + (filterKey.fullSeriesTitle ? `  fullTitle=${filterKey.fullSeriesTitle}` : `  calendar→semester`),
      )
    }

    let series: Awaited<ReturnType<typeof resolveSeriesForSubject>> = null

    if (!pinned && !episodeHintUuid) {
      const parsedForLu = parseMediaCourseKey(courseStr, semester)
      const isLuOnly = parsedForLu.fullSeriesTitle === null && parsedForLu.lu.length >= 3

      if (isLuOnly) {
        for (const semTry of luOnlyDiscoverySemestersInOrder(semester)) {
          series = await resolveSeriesForSubject({
            baseUrl: base,
            semester: semTry,
            mediaCourseId: subject.mediaCourseId,
            mediaSeriesIdHint: subject.mediaSeriesId,
          })
          if (series) {
            filterKey = parseMediaCourseKey(courseStr, semTry)
            if (semTry !== semester) {
              console.warn(
                `[discover]   Matched LU ${parsedForLu.lu} with semester=${semTry} (calendar/MEDIA_SEMESTER hint was ${semester})`,
              )
            }
            break
          }
        }
      }
      else {
        series = await resolveSeriesForSubject({
          baseUrl: base,
          semester,
          mediaCourseId: subject.mediaCourseId,
          mediaSeriesIdHint: subject.mediaSeriesId,
        })
      }
    }
    else {
      series = await resolveSeriesForSubject({
        baseUrl: base,
        semester,
        mediaCourseId: subject.mediaCourseId,
        mediaSeriesIdHint: subject.mediaSeriesId,
      })
    }

    if (!series && episodeHintUuid) {
      const boot = await fetchEpisodeMediapackageById(base, episodeHintUuid)
      if (boot) {
        series = { id: boot.seriesId, title: boot.episode.seriestitle || '(episode hint)' }
        filterKey = parseMediaCourseKey(boot.episode.seriestitle, semester)
      }
    }

    if (!series) {
      console.warn(
        episodeHintUuid
          ? `[discover]   No OpenCast lookup for mediapackage ${episodeHintUuid} (anonymous search empty). Paste the same URL into Media Course ID, set MEDIA_SESSION_COOKIE from a logged-in browser, or pin Media Series ID (OpenCast series UUID). Original course key sem ${filterKey.semester} LU ${filterKey.lu || '(none)'}`
          : `[discover]   No OpenCast series for «${courseStr || '(empty)'}» → sem ${filterKey.semester} + LU ${filterKey.lu}`,
      )
      continue
    }

    console.log(`[discover]   Series «${series.title}» (${series.id})`)

    let episodes
    try {
      episodes = await fetchEpisodesForSeries(base, series.id)
    } catch (e) {
      console.error(`[discover]   Episodes fetch failed:`, e)
      continue
    }

    let kept = episodes
    if (!pinned && filterKey.lu.length >= 3) {
      kept = episodes.filter((ep) => seriesTitlesMatch(ep.seriestitle.trim(), filterKey.semester, filterKey.lu))
    }

    if (episodes.length > 0 && kept.length === 0) {
      const sample = [...new Set(episodes.slice(0, 8).map((e) => (e.seriestitle.trim() || '(empty)')))]
      console.warn(
        `[discover]   Episode seriestitle did not match ${filterKey.semester} + LU ${filterKey.lu}`
          + ` (samples: ${sample.join('; ')})`
          + ` — using ${episodes.length} episodes anyway (trusted series UUID ${series.id})`,
      )
      kept = episodes
    }

    console.log(`[discover]   Episodes ${episodes.length} → kept after LU/semester filter: ${kept.length}`)

    for (const ep of kept) {
      const existing = existingLectures.get(ep.id)
      if (existing?.status === 'Done') continue

      discovered.push({
        id: ep.id,
        title: ep.title,
        courseId: subject.id,
        moodleUrl: lecturePageUrl(ep.id, base),
        opencastUrl: ep.mp4Url,
        glossary: subject.glossary?.trim() || undefined,
      })
    }
  }

  discovered.sort((a, b) => b.id.localeCompare(a.id))
  console.log(`[discover] Found ${discovered.length} lectures to process`)
  return discovered
}
