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
import { transcribe, type TranscribeProvider } from './transcribe'
import {
  isQuotaError,
  QuotaError,
  stageBefore,
  type Stage,
} from './types'

const FORCE = process.env.FORCE_RERIP === 'true'
const COURSE_FILTER = process.env.COURSE_FILTER || undefined

interface RunStats {
  processed: number
  deferred: number
  failed: number
}

function logQuotaDeferralHint(e: QuotaError): void {
  const resume =
    e.resumeAfter === 'utc_hour'
      ? 'Retries on the next hourly run after the UTC hour rolls over.'
      : 'Retries after UTC midnight resets daily Groq Whisper / Groq audio / Gemini counters.'
  console.warn(`[lecture-rip] Hit quota (${e.resumeAfter}); ${resume}`)
  console.warn(`  ${e.message}`)
}

/** Before FFmpeg / MP4 fetch: allow work if Groq can cover this lecture OR Gemini-audio fallback can. */
function ensureTranscribeBudgetBeforeNewHeavyWork(budget: BudgetTracker, estimatedAudioSeconds?: number): void {
  const est =
    estimatedAudioSeconds != null && Number.isFinite(estimatedAudioSeconds) && estimatedAudioSeconds > 0
      ? Math.ceil(estimatedAudioSeconds)
      : undefined

  const groqOk = budget.canAffordGroqRequest()
    && (est !== undefined ? budget.canAffordGroq(est) : budget.groqRemaining > 60)

  const geminiOk =
    est !== undefined
      ? budget.canAffordGeminiTranscriptionForDuration(est)
      : budget.canAffordGeminiAudio()

  if (groqOk || geminiOk) return

  if (!budget.canAffordGroqRequest()) {
    throw new QuotaError(
      'groq',
      'daily Whisper request limit reached; Gemini-audio budget insufficient for fallback',
      'utc_midnight',
    )
  }

  if (est !== undefined) {
    if (budget.groqDailyAudioRemaining < est) {
      throw new QuotaError(
        'groq',
        'daily Groq decoded-audio limit; Gemini-audio budget insufficient for fallback',
        'utc_midnight',
      )
    }
    if (budget.groqRemaining < est) {
      throw new QuotaError(
        'groq',
        'hourly Groq decoded-audio limit; Gemini-audio budget insufficient for fallback',
        'utc_hour',
      )
    }
  }
  else {
    throw new QuotaError(
      'groq',
      'low Groq hourly budget and Gemini-audio exhausted — refusing unknown-duration download',
      'utc_hour',
    )
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
    ensureTranscribeBudgetBeforeNewHeavyWork(budget, lec.durationSeconds)
    audioPath = await downloadAndConvert(lec.opencastUrl, lec.id)
    await setStage(pageId, 'Downloaded')
    currentStatus = 'Downloaded'
  }

  if (stageBefore(currentStatus, 'Transcribed')) {
    if (!audioPath) {
      audioPath = `tmp/${lec.id}.opus`
      const exists = await Bun.file(audioPath).exists()
      if (!exists) {
        ensureTranscribeBudgetBeforeNewHeavyWork(budget, lec.durationSeconds)
        audioPath = await downloadAndConvert(lec.opencastUrl, lec.id)
      }
    }

    const audioSeconds = await getAudioDuration(audioPath)

    let provider: TranscribeProvider = budget.groqCoversTranscription(audioSeconds) ? 'groq' : 'gemini'

    if (provider === 'gemini') {
      console.log('[lecture-rip] Groq quota tight — using Gemini audio for this lecture')
      if (!budget.canAffordGeminiTranscriptionForDuration(audioSeconds)) {
        throw new QuotaError(
          'gemini',
          'Gemini-audio transcription budget insufficient for this lecture',
          'utc_midnight',
        )
      }
    }

    const tier = provider === 'groq' && budget.shouldDownshiftGroq() ? 'fast' : 'best'
    if (tier === 'fast') console.log(`[lecture-rip] Budget pressure — using whisper-large-v3-turbo`)

    try {
      await transcribe(audioPath, lec.id, {
        glossary: lec.glossary,
        tier,
        budget,
        provider,
      })
    } catch (e: unknown) {
      if (provider === 'groq' && isQuotaError(e) && budget.canAffordGeminiAudio()) {
        console.warn(`[lecture-rip] Groq 429 mid-transcribe — falling back to Gemini audio`)
        provider = 'gemini'
        await transcribe(audioPath, lec.id, {
          glossary: lec.glossary,
          budget,
          provider: 'gemini',
        })
      } else {
        throw e
      }
    }
    if (provider === 'groq') {
      budget.recordGroqUsage(audioSeconds)
    }
    await budget.save()

    await setStage(pageId, 'Transcribed')
    currentStatus = 'Transcribed'
  }

  if (stageBefore(currentStatus, 'Postprocessed')) {
    const transcriptFile = Bun.file(`.cache/transcripts/${lec.id}.json`)
    if (!(await transcriptFile.exists())) {
      throw new Error(`Transcript not found for ${lec.id} — expected at .cache/transcripts/${lec.id}.json`)
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
