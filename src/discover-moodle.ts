import { MoodleSession, currentSemester, courseNumbers, normalizeCourseNumber, parseEpisodeScript, selectSemesterCourses, type MoodleCourse } from './moodle'
import type { DiscoveredLecture } from './discover'
import type { Lecture, Subject } from './types'

export function episodeToLecture(episode: any, subject: Subject, moodleUrl: string): DiscoveredLecture {
  const id = episode?.metadata?.id
  if (!/^[0-9a-f-]{36}$/i.test(id ?? '')) throw new Error('Invalid Opencast episode ID')
  const streams = (episode.streams ?? []).filter((s: any) => s.sources?.mp4?.length)
  // Presenter usually contains the lecturer audio; prefer lower-resolution downloadable video.
  const stream = streams.find((s: any) => s.content === 'presenter') ?? streams.find((s: any) => s.role === 'mainAudio') ?? streams[0]
  const tracks = [...(stream?.sources?.mp4 ?? [])].sort((a, b) => (a.res?.h ?? 9999) - (b.res?.h ?? 9999))
  const url = tracks[0]?.src
  if (!url || !['media.jku.at', 'stream.jku.at'].includes(new URL(url).hostname)) throw new Error('No approved MP4 track in Moodle recording')
  return {
    id, title: episode.metadata.title || 'Lecture recording', courseId: subject.id,
    courseSlug: subject.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    moodleUrl, opencastUrl: url, glossary: subject.glossary || undefined,
    durationSeconds: Number(episode.metadata.duration) > 0 ? Number(episode.metadata.duration) : undefined,
  }
}

export function matchCourseSubject(course: MoodleCourse, subjects: Subject[], semester: string): Subject | undefined {
  const numbers = new Set(courseNumbers(course))
  const matches = subjects.filter(s => {
    if (s.semester && s.semester !== semester) return false
    const fullKey = s.mediaCourseId.match(/^(\d{4}[WS])(.+)$/i)
    if (fullKey && fullKey[1]!.toUpperCase() !== semester) return false
    const keys = [s.courseNumber, s.ueCourseNumber, fullKey?.[2]].filter((x): x is string => Boolean(x))
    return keys.some(k => numbers.has(normalizeCourseNumber(k)))
  })
  if (matches.length > 1) throw new Error(`Ambiguous Subject mapping for Moodle course ${course.id}; refusing to guess`)
  return matches[0]
}

export async function discoverLecturesFromMoodle(
  session: MoodleSession, subjects: Subject[], existing: Map<string, Lecture>,
  opts: { semester?: string; courseFilterRegex?: string; force?: boolean } = {},
): Promise<DiscoveredLecture[]> {
  const semester = opts.semester ?? currentSemester()
  const filter = opts.courseFilterRegex ? new RegExp(opts.courseFilterRegex, 'i') : null
  const courses = selectSemesterCourses(await session.courses(), semester)
  const out = new Map<string, DiscoveredLecture>()
  let mapped = 0, activities = 0, recordingCount = 0
  for (const course of courses) {
    const subject = matchCourseSubject(course, subjects, semester)
    if (!subject) { console.warn(`[moodle] Course ${course.id}: no exact Subject number match; skipped`); continue }
    if (filter && !filter.test(subject.name)) continue
    mapped++
    const courseParts = await session.parts(`https://moodle.jku.at/course/view.php?id=${course.id}`)
    const modules = [...new Map(courseParts.activities.map(a => [a.url, a])).values()]
    activities += modules.length
    console.log(`[moodle] ${subject.name}: ${modules.length} Opencast activities`)
    for (const activity of modules) {
      const parts = await session.parts(activity.url)
      if (!parts.episodes.length && !parts.episodeScript && !parts.launches.length) {
        console.log(`[moodle] Opencast activity has no published recordings yet`)
        continue
      }
      const entries = parts.episodes.length ? parts.episodes : [{ title: activity.title, url: activity.url }]
      for (const entry of entries) {
        let episode = parts.episodes.length ? null : parseEpisodeScript(parts.episodeScript)
        const id = episode?.metadata?.id || new URL(entry.url).searchParams.get('e')
        recordingCount++
        if (id && existing.get(id)?.status === 'Done' && !opts.force) continue
        if (id && out.has(id)) continue
        // Every pending recording receives its own authenticated Moodle LTI launch.
        const authorized = await session.authorizePlayer(entry.url)
        episode = episode ?? authorized
        const lecture = episodeToLecture(episode, subject, entry.url)
        if (existing.get(lecture.id)?.status === 'Done' && !opts.force) continue
        out.set(lecture.id, lecture)
      }
    }
  }
  if (!mapped) throw new Error('No current Moodle courses matched Subjects/course filter; refusing silent empty success')
  console.log(`[moodle] ${mapped} courses, ${activities} recording activities, ${recordingCount} entries, ${out.size} pending lectures`)
  if (!recordingCount) console.warn('[moodle] No recordings published in matched courses. Authentication succeeded; nothing to process.')
  return [...out.values()]
}
