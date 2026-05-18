import { BudgetTracker } from './budget'
import { discoverLecturesFromMedia } from './discover'
import { cleanup, downloadAndConvert, getAudioDuration } from './download'
import {
  fetchExistingLectures,
  fetchSubjects,
  setSkipReason,
  setStage,
  upsertLecture,
  validateLecturesDatabaseConfig,
  writePostprocessResults,
} from './notion'
import { postprocess } from './postprocess'
import { semesterAnchorForPipeline } from './semester'
import { transcribe, type TranscriptionProvider } from './transcribe'
import {
  isQuotaError,
  QuotaError,
  stageBefore,
  type Stage,
} from './types'

const FORCE = process.env.FORCE_RERIP === 'true'
const COURSE_FILTER = process.env.COURSE_FILTER || undefined

/** CLI `--local` or `TRANSCRIBE_LOCAL=true`: run whisper.cpp on disk instead of Groq API (see WHISPER_MODEL_PATH). */
const TRANSCRIBE_LOCAL =
  process.argv.includes('--local')
  || (process.env.TRANSCRIBE_LOCAL ?? '').trim().toLowerCase() === 'true'

function transcriptionProvider(): TranscriptionProvider {
  return TRANSCRIBE_LOCAL ? 'local' : 'groq'
}

function transcriptJsonPath(lectureId: string): string {
  return `.cache/transcripts/${lectureId}.${transcriptionProvider()}.json`
}

/** Prefer provider-specific cache; fall back to legacy `.cache/transcripts/<id>.json` from older runs. */
async function resolveTranscriptJsonPath(lectureId: string): Promise<string> {
  const primary = transcriptJsonPath(lectureId)
  if (await Bun.file(primary).exists())
    return primary
  const legacy = `.cache/transcripts/${lectureId}.json`
  if (await Bun.file(legacy).exists())
    return legacy
  return primary
}

interface RunStats {
  processed: number
  deferred: number
  failed: number
}

function logQuotaDeferralHint(e: QuotaError): void {
  const resume =
    e.resumeAfter === 'utc_hour'
      ? 'Retries on the next hourly run after the UTC hour rolls over.'
      : 'Retries after UTC midnight resets daily Groq / Gemini counters.'
  console.warn(`[lecture-rip] Hit quota (${e.resumeAfter}); ${resume}`)
  console.warn(`  ${e.message}`)
}

/** Before FFmpeg / MP4 fetch: avoid burning bandwidth when Whisper requests or audio quota are insufficient. */
function ensureGroqBudgetBeforeNewHeavyWork(budget: BudgetTracker, estimatedAudioSeconds?: number): void {
  if (TRANSCRIBE_LOCAL)
    return

  if (!budget.canAffordGroqRequest()) {
    throw new QuotaError(
      'groq',
      'daily Whisper API request limit reached',
      'utc_midnight',
    )
  }

  const est =
    estimatedAudioSeconds != null && Number.isFinite(estimatedAudioSeconds) && estimatedAudioSeconds > 0
      ? Math.ceil(estimatedAudioSeconds)
      : undefined

  if (est !== undefined) {
    if (!budget.canAffordGroq(est)) {
      throw new QuotaError(
        'groq',
        `decoded-audio quota: need ~${est}s but hourly or daily limit reached`,
        budget.groqRemaining < est ? 'utc_hour' : 'utc_midnight',
      )
    }
  }
  else {
    if (budget.groqRemaining <= 60) {
      throw new QuotaError(
        'groq',
        '<60s hourly Groq audio budget left — refusing unknown-duration download until next UTC hour',
        'utc_hour',
      )
    }
  }
}

async function main() {
  console.log('[lecture-rip] Starting pipeline...')
  console.log(`[lecture-rip] force_rerip=${FORCE}, course_filter=${COURSE_FILTER ?? '(none)'}`)
  const semesterInfo = semesterAnchorForPipeline()
  const semLog =
    semesterInfo.source === 'env'
      ? `${semesterInfo.semester} (from MEDIA_SEMESTER)`
      : `${semesterInfo.semester} (auto • JKU calendar • ${semesterInfo.timeZoneUsed ?? '?'}; Oct–Feb→W • Mar–Sep→S)`
  console.log(`[lecture-rip] MEDIA_SEMESTER=${semLog}`)
  console.log(`[lecture-rip] transcription=${TRANSCRIBE_LOCAL ? 'local (whisper.cpp)' : 'groq_api'}`)

  const budget = await BudgetTracker.load()
  console.log(`[lecture-rip] Budget: ${budget.summary()}`)

  await validateLecturesDatabaseConfig()

  const subjects = await fetchSubjects()
  console.log(`[lecture-rip] Found ${subjects.length} subjects`)

  const existingLectures = await fetchExistingLectures()
  console.log(`[lecture-rip] ${existingLectures.size} existing lecture rows in Notion`)

  const discovered = await discoverLecturesFromMedia(subjects, existingLectures, {
    courseFilterRegex: COURSE_FILTER,
  })

  const stats: RunStats = { processed: 0, deferred: 0, failed: 0 }

  for (const lec of discovered) {
    const existing = existingLectures.get(lec.id)
    let pageId = existing?.notionPageId

    try {
      pageId = await upsertLecture(lec, pageId)

      let currentStatus: Stage = existing?.status ?? 'Discovered'

      if (FORCE) {
        await setStage(pageId, 'Discovered')
        currentStatus = 'Discovered'
      }

      if (currentStatus === 'Done' && !FORCE) {
        continue
      }

      await processLecture(pageId, lec, currentStatus, budget)
      stats.processed++
    }
    catch (e) {
      if (isQuotaError(e)) {
        logQuotaDeferralHint(e)
        console.warn(`[lecture-rip] Budget: ${budget.summary()}`)
        stats.deferred = discovered.length - discovered.indexOf(lec)
        await budget.save()
        break
      }

      console.error(`[lecture-rip] Failed: ${lec.title}`, e)
      if (pageId) await markFailed(pageId, e)
      stats.failed++
    }
  }

  await budget.save()

  console.log(`\n[lecture-rip] Run complete.`)
  console.log(`  processed: ${stats.processed}, deferred: ${stats.deferred}, failed: ${stats.failed}`)
  console.log(`  Budget: ${budget.summary()}`)
}

async function processLecture(
  pageId: string,
  lec: { id: string; title: string; opencastUrl: string; glossary?: string; durationSeconds?: number },
  currentStatus: Stage,
  budget: BudgetTracker,
): Promise<void> {
  console.log(`\n[lecture-rip] Processing: ${lec.title} (status: ${currentStatus})`)

  let audioPath: string | undefined

  if (stageBefore(currentStatus, 'Downloaded')) {
    ensureGroqBudgetBeforeNewHeavyWork(budget, lec.durationSeconds)
    audioPath = await downloadAndConvert(lec.opencastUrl, lec.id)
    await setStage(pageId, 'Downloaded')
    currentStatus = 'Downloaded'
  }

  if (stageBefore(currentStatus, 'Transcribed')) {
    if (!audioPath) {
      audioPath = `tmp/${lec.id}.opus`
      const exists = await Bun.file(audioPath).exists()
      if (!exists) {
        ensureGroqBudgetBeforeNewHeavyWork(budget, lec.durationSeconds)
        audioPath = await downloadAndConvert(lec.opencastUrl, lec.id)
      }
    }

    const audioSeconds = await getAudioDuration(audioPath)

    if (!TRANSCRIBE_LOCAL) {
      if (!budget.canAffordGroq(audioSeconds)) {
        throw new QuotaError(
          'groq',
          `decoded-audio quota: need ~${Math.ceil(audioSeconds)}s but hourly or daily limit reached`,
          budget.groqRemaining < audioSeconds ? 'utc_hour' : 'utc_midnight',
        )
      }
    }

    const tier = TRANSCRIBE_LOCAL ? 'best' : budget.shouldDownshiftGroq() ? 'fast' : 'best'
    if (!TRANSCRIBE_LOCAL && tier === 'fast')
      console.log(`[lecture-rip] Budget pressure — using whisper-large-v3-turbo`)

    await transcribe(audioPath, lec.id, {
      glossary: lec.glossary,
      tier,
      budget,
      provider: transcriptionProvider(),
    })

    if (!TRANSCRIBE_LOCAL) {
      budget.recordGroqUsage(audioSeconds)
      await budget.save()
    }

    await setStage(pageId, 'Transcribed')
    currentStatus = 'Transcribed'
  }

  if (stageBefore(currentStatus, 'Postprocessed')) {
    const tpath = await resolveTranscriptJsonPath(lec.id)
    const transcriptFile = Bun.file(tpath)
    if (!(await transcriptFile.exists())) {
      throw new Error(
        `Transcript not found for ${lec.id} — expected at ${transcriptJsonPath(lec.id)}`
        + ` (legacy .cache/transcripts/${lec.id}.json also checked)`,
      )
    }
    const transcript = await transcriptFile.json()

    const output = await postprocess(transcript.text, {
      beforeGeminiRequest: () => {
        if (!budget.canAffordGemini()) {
          throw new QuotaError('gemini', 'daily Gemini request limit reached', 'utc_midnight')
        }
      },
      onGeminiRequest: () => budget.recordGeminiUsage(),
    })
    await budget.save()

    await writePostprocessResults(pageId, output)
    await setStage(pageId, 'Postprocessed')
    currentStatus = 'Postprocessed'
  }

  await setStage(pageId, 'Done')
  await cleanup(lec.id)
  console.log(`[lecture-rip] Done: ${lec.title}`)
}

async function markFailed(pageId: string, error: unknown): Promise<void> {
  await setStage(pageId, 'Failed')
  const msg = error instanceof Error ? error.message : String(error)
  await setSkipReason(pageId, `error: ${msg.slice(0, 200)}`)
}

main().catch(e => {
  console.error('[lecture-rip] Fatal error:', e)
  process.exit(1)
})
