import type { Lecture, Subject } from './types'
import { slugifyCourseName } from './cards'
import {
  normalizeMediaBase,
  extractEpisodeHintUuid,
  fetchEpisodeMediapackageById,
  fetchEpisodesByQuery,
  fetchEpisodesForSeries,
  lecturePageUrl,
  parseMediaCourseKey,
  resolveSeriesForSubject,
  seriesTitlesMatch,
  type MediaEpisode,
} from './media-jku'
import { luOnlyDiscoverySemestersInOrder, semesterAnchorForPipeline } from './semester'

/** Opt-in heuristic that can tie-break wrong semester / wrong course (same LU digits elsewhere). Default off. */
function envMediaResolveLooseLuBool(): boolean {
  const raw = typeof process !== 'undefined' ? (process.env.MEDIA_RESOLVE_LOOSE_LU ?? '').trim().toLowerCase() : ''
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/** When false (default), skip subjects whose explicit **Media Course ID** carries another OpenCast semester than the pipeline anchor (e.g. `2025W…` rows while anchor is auto `2026S`). Set `true` if you deliberately keep WS keys during SS (`MEDIA_ALLOW_OFF_ANCHOR_MEDIA_KEYS`). */
function envAllowOffAnchorExplicitMediaKeys(): boolean {
  const raw =
    typeof process !== 'undefined' ? (process.env.MEDIA_ALLOW_OFF_ANCHOR_MEDIA_KEYS ?? '').trim().toLowerCase() : ''
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/** If false (default), LU-only discovery only keeps series whose OpenCast title matches anchor `YYYY[SW]{LU}` — no silent fallback to an older term. */
function envAllowOlderSemLuFallback(): boolean {
  const raw =
    typeof process !== 'undefined' ? (process.env.MEDIA_LU_ALLOW_OLDER_SEM_FALLBACK ?? '').trim().toLowerCase() : ''
  return raw === '1' || raw === 'true' || raw === 'yes'
}

type ResolvedSeriesHit = NonNullable<Awaited<ReturnType<typeof resolveSeriesForSubject>>>

/** Probe each ladder semester once; dedup by OpenCast series UUID, keep insertion order (ladder-first). */
async function collectLuSeriesCandidatesAcrossLadder(
  base: string,
  mediaCourseId: string,
  mediaSeriesHint: string,
  ladderSemesters: readonly string[],
  allowLooseLu: boolean,
): Promise<Array<{ sem: string; hit: ResolvedSeriesHit }>> {
  const seen = new Set<string>()
  const ordered: Array<{ sem: string; hit: ResolvedSeriesHit }> = []

  for (const semTry of ladderSemesters) {
    const hit = await resolveSeriesForSubject({
      baseUrl: base,
      semester: semTry,
      mediaCourseId,
      mediaSeriesIdHint: mediaSeriesHint,
      allowLooseLu,
    })
    if (hit && !seen.has(hit.id)) {
      seen.add(hit.id)
      ordered.push({ sem: semTry, hit })
    }
  }

  return ordered
}

/**
 * Prefer OpenCast series whose **title** matches `{anchorSem}{LU}` (current term). If none, only fall back to
 * older ladder matches when **`MEDIA_LU_ALLOW_OLDER_SEM_FALLBACK=true`**.
 */
function pickPreferredLuSeries(
  anchorSem: string,
  luDigits: string,
  ordered: Array<{ sem: string; hit: ResolvedSeriesHit }>,
): { sem: string; hit: ResolvedSeriesHit } | null {
  if (ordered.length === 0) return null

  const anchorTitleMatches = ordered.filter(({ hit }) =>
    seriesTitlesMatch(hit.title.trim(), anchorSem, luDigits),
  )

  if (anchorTitleMatches.length > 0) {
    const exactLadder = anchorTitleMatches.find(({ sem }) => sem === anchorSem)
    return exactLadder ?? anchorTitleMatches[0]!
  }

  if (envAllowOlderSemLuFallback()) {
    const byAnchoredSem = ordered.find(({ sem }) => sem === anchorSem)
    if (byAnchoredSem) return byAnchoredSem

    if (ordered.length > 1) {
      const titles = ordered.map(({ hit }) => hit.title.trim()).slice(0, 4)
      console.warn(
        `[discover]   LU ${luDigits}: ${ordered.length} older-term OpenCast series (${titles.join(' · ')}…); `
          + `picking ladder-first («${ordered[0]!.hit.title}», ${ordered[0]!.sem}) because MEDIA_LU_ALLOW_OLDER_SEM_FALLBACK=true.`,
      )
    }
    else {
      console.warn(
        `[discover]   LU ${luDigits}: using «${ordered[0]!.hit.title}» (${ordered[0]!.sem}) — no title match for anchor ${anchorSem}.`,
      )
    }
    return ordered[0] ?? null
  }

  const samples = ordered.map(({ hit, sem }) => `${hit.title.trim()} (${sem})`).slice(0, 3).join(' · ')
  console.warn(
    `[discover]   LU ${luDigits}: anchor ${anchorSem} has no OpenCast series title match (only: ${samples}). `
      + `Skipped. Use full **Media Course ID** (e.g. ${anchorSem}${luDigits}), pin **Media Series ID**, or set **MEDIA_LU_ALLOW_OLDER_SEM_FALLBACK=true** to allow older terms.`,
  )
  return null
}

export interface DiscoveredLecture {
  id: string
  title: string
  courseId: string
  courseSlug: string
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

/** Prefer episodes whose title/seriestitle mentions the pipeline semester; keep all if none match. */
function filterEpisodesBySemesterHint(episodes: MediaEpisode[], semester: string): MediaEpisode[] {
  const sem = semester.trim()
  if (!sem) return episodes
  const filtered = episodes.filter((ep) => {
    const blob = `${ep.title} ${ep.seriestitle}`.toLowerCase()
    return blob.includes(sem.toLowerCase())
  })
  return filtered.length > 0 ? filtered : episodes
}

function appendDiscoveredEpisodes(
  discovered: DiscoveredLecture[],
  episodes: MediaEpisode[],
  subject: Subject,
  base: string,
  existingLectures: Map<string, Lecture>,
): void {
  for (const ep of episodes) {
    const existing = existingLectures.get(ep.id)
    if (existing?.status === 'Done') continue

    discovered.push({
      id: ep.id,
      title: ep.title,
      courseId: subject.id,
      courseSlug: slugifyCourseName(subject.name),
      moodleUrl: lecturePageUrl(ep.id, base),
      opencastUrl: ep.mp4Url,
      glossary: subject.glossary?.trim() || undefined,
    })
  }
}

/**
 * Discover lectures via media.jku.at (`/search/series.json`, `/search/episode.json`).
 * Each Notion Subject needs **Media Course ID** (series name like `2026S344090`, LU digits only, or Engage/play URL),
 * and/or **Media Series ID** (OpenCast UUID). Anonymous discovery may lag ACL; **`MEDIA_SESSION_COOKIE`** aligns with Paella.
 * Calendar `MEDIA_SEMESTER` is ignored when the series name embeds `YYYYW|YYYYS`.
 * LU-only rows prefer series whose OpenCast **title** matches the anchor term (`2026S`+LU). Older terms (e.g. `2025W…`) are skipped unless **`MEDIA_LU_ALLOW_OLDER_SEM_FALLBACK=true`**.
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

  if (!semester) {
    const anchor = semesterAnchorForPipeline()
    semester = anchor.semester
    if (anchor.source === 'auto' && anchor.timeZoneUsed) {
      console.log(`[discover] semester anchor ${anchor.semester} (auto • OpenCast/JKU • ${anchor.timeZoneUsed}; Oct→W Jan–Feb→W Mar–Sep→S)`)
    }
  }
  else {
    const m = semester.match(/^(\d{4})([SsWw])$/i)
    if (m) semester = `${m[1]}${m[2].toUpperCase()}`
    else {
      console.warn(`[discover] MEDIA_SEMESTER «${semester}» is not YYYY[SW]; using calendar anchor`)
      const anchor = semesterAnchorForPipeline()
      semester = anchor.semester
      if (anchor.source === 'auto' && anchor.timeZoneUsed) {
        console.log(`[discover] semester anchor ${anchor.semester} (auto • ${anchor.timeZoneUsed})`)
      }
    }
  }

  console.log(`[discover] media.jku.at  semester=${semester}  base=${base}`)

  const discovered: DiscoveredLecture[] = []

  for (const subject of subjects) {
    if (filterRegex && !filterRegex.test(subject.name)) continue

    console.log(`[discover] Subject: ${subject.name}`)

    const pinned = parseUuid(subject.mediaSeriesId.trim())
    const courseStr = subject.mediaCourseId.trim()

    if (!courseStr && !subject.mediaSeriesId.trim()) {
      console.warn(`[discover]   Skip: add "Media Course ID" or "Media Series ID" in Notion`)
      continue
    }

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

    /** Explicit OpenCast keys in Notion (`2025W365217`) always win internally — skip when they disagree with anchor (auto/MEDIA_SEMESTER), including when a pinned UUID exists alongside that text. */
    if (
      !envAllowOffAnchorExplicitMediaKeys()
      && !episodeHintUuid
      && filterKey.fullSeriesTitle != null
      && filterKey.semester !== semester
    ) {
      console.warn(
        `[discover]   Skip: «${filterKey.fullSeriesTitle}» is ${filterKey.semester} but pipeline anchor is ${semester}. `
          + `Remove/archive for current term, use LU-only digits + anchor, or set MEDIA_ALLOW_OFF_ANCHOR_MEDIA_KEYS=true.`,
      )
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
        const ladder = luOnlyDiscoverySemestersInOrder(semester)
        let ordered = await collectLuSeriesCandidatesAcrossLadder(
          base,
          subject.mediaCourseId,
          subject.mediaSeriesId,
          ladder,
          false,
        )
        if (ordered.length === 0 && envMediaResolveLooseLuBool()) {
          ordered = await collectLuSeriesCandidatesAcrossLadder(
            base,
            subject.mediaCourseId,
            subject.mediaSeriesId,
            ladder,
            true,
          )
        }

        const picked = pickPreferredLuSeries(semester, parsedForLu.lu, ordered)
        if (picked) {
          series = picked.hit
          filterKey = parseMediaCourseKey(courseStr, picked.sem)
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
        const fkEpisode = parseMediaCourseKey(boot.episode.seriestitle, semester)
        if (
          !envAllowOffAnchorExplicitMediaKeys()
          && fkEpisode.fullSeriesTitle != null
          && fkEpisode.semester !== semester
        ) {
          console.warn(
            `[discover]   Skip: watch URL maps to «${fkEpisode.fullSeriesTitle}» (${fkEpisode.semester}) but anchor is ${semester}.`,
          )
          continue
        }
        series = { id: boot.seriesId, title: boot.episode.seriestitle || '(episode hint)' }
        filterKey = fkEpisode
      }
    }

    if (!series) {
      if (courseStr) {
        console.log(`[discover]   No series — trying episode search q=«${courseStr}»`)
        try {
          const raw = await fetchEpisodesByQuery(base, courseStr)
          const kept = filterEpisodesBySemesterHint(raw, semester)
          console.log(`[discover]   Episodes ${raw.length} → kept after semester hint: ${kept.length}`)
          appendDiscoveredEpisodes(discovered, kept, subject, base, existingLectures)
        }
        catch (e) {
          console.error(`[discover]   Episode search failed:`, e)
        }
        continue
      }

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

    appendDiscoveredEpisodes(discovered, kept, subject, base, existingLectures)
  }

  discovered.sort((a, b) => b.id.localeCompare(a.id))
  console.log(`[discover] Found ${discovered.length} lectures to process`)
  return discovered
}
