import { describe, test, expect } from 'bun:test'
import { MoodleSession, courseNumbers, currentSemester, parseEpisodeScript, collectCalendarEvents } from '../src/moodle'

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
    s.ajax = async (_m, a) => ({ courses: a.offset === 0 ? Array.from({ length: 50 }, (_, i) => ({ id: i + 1 })) : [{ id: 51 }], nextoffset: 50 }) as any
    expect((await s.courses()).length).toBe(51)
  })
  test('media cookies cannot be forwarded to an arbitrary host', async () => {
    const s = new MoodleSession({} as any)
    await expect(s.fetchMedia('https://example.com/private')).rejects.toThrow('approved JKU hosts')
  })
})
