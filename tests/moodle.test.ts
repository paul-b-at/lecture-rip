import { describe, test, expect } from 'bun:test'
import { MoodleSession, courseNumbers, currentSemester, parseEpisodeScript, collectCalendarEvents, selectSemesterCourses, courseSemesterLabels, isAuthenticatedMoodleState } from '../src/moodle'

describe('Moodle shared adapter', () => {
  test('JKU calendar transitions use Vienna, including UTC boundary', () => {
    expect(currentSemester(new Date('2026-09-30T22:01:00Z'))).toBe('2026W')
    expect(currentSemester(new Date('2027-01-01T00:00:00Z'))).toBe('2026W')
    expect(currentSemester(new Date('2027-03-01T00:00:00Z'))).toBe('2027S')
  })
  test('expands grouped course numbers without corrupting W01', () => {
    expect(courseNumbers({ fullname: '340.320-33, UE AlgoDat', shortname: '' })).toContain('340332')
    const ai = courseNumbers({ fullname: '344.021/2/3/57/103/W01, UE AI', shortname: '' })
    expect(ai).toEqual(['344021', '344022', '344023', '344057', '344103', '344W01'])
    expect(courseNumbers({ fullname: '357.260/531940/531942, Math', shortname: '' })).toContain('531942')
  })
  test('parses balanced JSON, not JavaScript expressions', () => {
    expect(parseEpisodeScript('window.episode = {"metadata":{"title":"braces } { and quote \\\""},"streams":[]};')).toEqual({ metadata: { title: 'braces } { and quote "' }, streams: [] })
    expect(() => parseEpisodeScript('window.episode = {run: dangerous()};')).toThrow()
    expect(parseEpisodeScript('unrelated();')).toBeNull()
  })
  test('monthly event traversal deduplicates repeating nested export records', () => {
    const e = { id: 1, name: 'Test', modulename: 'quiz', eventtype: 'close', timestart: 123 }
    expect(collectCalendarEvents({ weeks: [{ days: [{ events: [e, e] }] }] })).toEqual([e])
  })
  test('action feed paginates beyond 50 events', async () => {
    const s = new MoodleSession({} as any)
    const calls: any[] = []
    s.ajax = async (_method, args) => {
      calls.push(args)
      return (args.aftereventid === 0 ? { events: Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })), lastid: 50 } : { events: [{ id: 51 }], lastid: 51 }) as any
    }
    expect((await s.actionEvents(1, 99)).length).toBe(51)
    expect(calls[1].aftereventid).toBe(50)
  })
  test('stalled task pagination fails rather than reporting incomplete success', async () => {
    const s = new MoodleSession({} as any)
    s.ajax = async () => ({ events: Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })), lastid: 0 }) as any
    await expect(s.actionEvents(1, 99)).rejects.toThrow('pagination')
  })
  test('course list pagination handles multiple full pages', async () => {
    const s = new MoodleSession({} as any)
    s.ajax = async (_m, a) => ({ courses: a.offset === 0 ? Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })) : a.offset === 50 ? [{ id: 51 }] : [], nextoffset: a.offset === 0 ? 50 : 51 }) as any
    expect((await s.courses()).length).toBe(51)
  })
  test('media cookies cannot be forwarded to an arbitrary host', async () => {
    const s = new MoodleSession({} as any)
    await expect(s.fetchMedia('https://example.com/private')).rejects.toThrow('approved JKU hosts')
  })
})

test('course pagination follows cursor across partial and empty intermediate pages', async () => {
  const session = new MoodleSession({} as any)
  const calls: any[] = []
  session.ajax = async (_method, args) => {
    calls.push(args)
    if (args.offset === 0) return { courses: [{ id: 1 }], nextoffset: 50 } as any
    if (args.offset === 50) return { courses: [], nextoffset: 100 } as any
    if (args.offset === 100) return { courses: [{ id: 2 }], nextoffset: 101 } as any
    return { courses: [], nextoffset: 101 } as any
  }
  expect((await session.courses()).map(c => c.id)).toEqual([1, 2])
  expect(calls.map(c => c.offset)).toEqual([0, 50, 100, 101])
  expect(calls.every(c => c.classification === 'allincludinghidden')).toBe(true)
})
test('course pagination rejects nonempty stalled cursor', async () => {
  const session = new MoodleSession({} as any)
  session.ajax = async () => ({ courses: [{ id: 1 }], nextoffset: 0 }) as any
  await expect(session.courses()).rejects.toThrow('did not advance')
})
test('semester selection supports suffix-only and case/space variations', () => {
  const c = { id: 1, shortname: 'custom', fullname: '365.075, VL Course, 2026W' }
  expect(selectSemesterCourses([c], '2026W')).toEqual([c])
  expect(courseSemesterLabels({ shortname: '2026 w365075', fullname: 'Course' })).toEqual(['2026W'])
  expect(courseSemesterLabels({ shortname: '2026Winter', fullname: 'Course' })).toEqual([])
})
test('course errors distinguish empty account from wrong term without publishing course names', () => {
  expect(() => selectSemesterCourses([], '2026W')).toThrow('0 enrolled courses')
  expect(() => selectSemesterCourses([{ id: 1, shortname: '2026S365075', fullname: 'private title' }], '2026W')).toThrow('Available terms: 2026S:1')
})

test('Moodle guest sesskey does not count as authentication', () => {
  expect(isAuthenticatedMoodleState({ hasSessionKey: true, userId: 1, hasLoginLink: false })).toBe(false)
  expect(isAuthenticatedMoodleState({ hasSessionKey: true, userId: 0, hasLoginLink: true })).toBe(false)
  expect(isAuthenticatedMoodleState({ hasSessionKey: true, userId: 200, hasLoginLink: true })).toBe(false)
  expect(isAuthenticatedMoodleState({ hasSessionKey: false, userId: 200, hasLoginLink: false })).toBe(false)
  expect(isAuthenticatedMoodleState({ hasSessionKey: true, userId: 200, hasLoginLink: false })).toBe(true)
})
test('guest session with missing workflow credentials fails before course discovery', async () => {
  const originalUser = process.env.JKU_USER, originalPass = process.env.JKU_PASS
  delete process.env.JKU_USER; delete process.env.JKU_PASS
  let closed = false
  const page = { goto: async () => {}, url: () => 'https://moodle.jku.at/my/', evaluate: async () => ({ hasSessionKey: true, userId: 1, hasLoginLink: true }), close: async () => { closed = true } }
  try {
    await expect(MoodleSession.open({ newPage: async () => page } as any)).rejects.toThrow('Missing Moodle sign-in environment variables: JKU_USER, JKU_PASS')
    expect(closed).toBe(true)
  } finally {
    if (originalUser === undefined) delete process.env.JKU_USER; else process.env.JKU_USER = originalUser
    if (originalPass === undefined) delete process.env.JKU_PASS; else process.env.JKU_PASS = originalPass
  }
})
