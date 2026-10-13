import { test, expect } from 'bun:test'
import { episodeToLecture, matchCourseSubject, discoverLecturesFromMoodle } from '../src/discover-moodle'
const subject = { id: 'subject', notionPageId: 'subject', name: 'AI UE', mediaCourseId: '2026W344W01', mediaSeriesId: '', glossary: '', semester: '2026W', ueCourseNumber: '344.W01' }
const course = { id: 45796, fullname: '344.021/2/3/W01, UE AI, 2026W', shortname: '2026W344021/2/3/W01' }
const episode = { metadata: { id: '2988b436-d41d-4e8f-bf31-9491e6267681', title: 'Recording', duration: 3166.8 }, streams: [{ content: 'presenter', sources: { mp4: [{ src: 'https://media.jku.at/a.mp4', res: { h: 1080 } }, { src: 'https://media.jku.at/b.mp4', res: { h: 480 } }] } }] }
test('grouped W01 course matches the exact Subject and rejects other semesters', () => {
  expect(matchCourseSubject(course, [subject], '2026W')).toEqual(subject)
  expect(matchCourseSubject(course, [{ ...subject, semester: '2025W', mediaCourseId: '2025W344W01' }], '2026W')).toBeUndefined()
})
test('ambiguous Subject mappings are not silently guessed', () => {
  expect(() => matchCourseSubject(course, [subject, { ...subject, id: 'other' }], '2026W')).toThrow('Ambiguous')
})
test('episode UUID survives, lowest-resolution presenter MP4 selected, stable Moodle link stored', () => {
  const l = episodeToLecture(episode, subject, 'https://moodle.jku.at/mod/opencast/view.php?id=1')
  expect(l.id).toBe(episode.metadata.id)
  expect(l.opencastUrl).toBe('https://media.jku.at/b.mp4')
  expect(l.durationSeconds).toBe(3166.8)
  expect(l.moodleUrl).not.toContain('sesskey')
})
test('done recordings skipped, force rerip includes them', async () => {
  let launches = 0
  const url = `https://moodle.jku.at/mod/opencast/view.php?id=1&e=${episode.metadata.id}`
  const fake = { courses: async () => [course], parts: async (u: string) => u.includes('/course/') ? { activities: [{ title: 'Recordings', url }]} : { episodes: [{ title: 'Recording', url }], episodeScript: null }, authorizePlayer: async () => { launches++; return episode } }
  const existing = new Map([[episode.metadata.id, { status: 'Done' } as any]])
  expect((await discoverLecturesFromMoodle(fake as any, [subject], existing, { semester: '2026W' })).length).toBe(0)
  expect(launches).toBe(0)
  expect((await discoverLecturesFromMoodle(fake as any, [subject], existing, { semester: '2026W', force: true })).length).toBe(1)
  expect(launches).toBe(1)
})
test('missing current courses fails, not a green empty sync', async () => {
  await expect(discoverLecturesFromMoodle({ courses: async () => [] } as any, [subject], new Map(), { semester: '2026W' })).rejects.toThrow('0 enrolled courses')
})

test('empty published recording collections do not attempt a player launch', async () => {
  const url = 'https://moodle.jku.at/mod/opencast/view.php?id=1'
  const fake = { courses: async () => [course], parts: async (u: string) => u.includes('/course/') ? { activities: [{ title: 'Recordings', url }] } : { episodes: [], episodeScript: null, launches: [] }, authorizePlayer: async () => { throw new Error('Should not launch empty collection') } }
  expect((await discoverLecturesFromMoodle(fake as any, [subject], new Map(), { semester: '2026W' })).length).toBe(0)
})
