import { z } from 'zod'

export const STAGES = ['Discovered', 'Downloaded', 'Transcribed', 'Postprocessed', 'Done', 'Failed', 'Skipped'] as const
export type Stage = (typeof STAGES)[number]

const STAGE_ORDER: Record<Stage, number> = {
  Discovered: 0,
  Downloaded: 1,
  Transcribed: 2,
  Postprocessed: 3,
  Done: 4,
  Failed: -1,
  Skipped: -1,
}

export function stageBefore(current: Stage, target: Stage): boolean {
  return STAGE_ORDER[current] < STAGE_ORDER[target]
}

export interface Lecture {
  id: string
  notionPageId: string
  title: string
  courseId: string
  moodleUrl: string
  opencastUrl?: string
  audioPath?: string
  transcriptPath?: string
  status: Stage
  skipReason?: string
  durationSeconds?: number
  glossary?: string
}

export interface Subject {
  id: string
  notionPageId: string
  name: string
  /** Opencast **series name** (`2026S344090`, `2025W338002/4`) **or** LU digits only (`344090`) — see `parseMediaCourseKey`. */
  mediaCourseId: string
  /** Optional: pin OpenCast series UUID instead of resolving by series name/LU */
  mediaSeriesId: string
  glossary: string
}

const examHintPriority = z.enum(['likely', 'tricky', 'general'])

/** Gemini `responseSchema` uses `{ hint, priority }` items; older runs or manual JSON may use plain strings. */
function normalizeExamHints(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const t = item.trim()
      if (t) out.push(t)
      continue
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      const hintRaw = o.hint
      const hint = typeof hintRaw === 'string' ? hintRaw.trim() : ''
      if (!hint) continue
      let tag: 'likely' | 'tricky' | 'general' | null = null
      if (typeof o.priority === 'string') {
        const pr = examHintPriority.safeParse(o.priority.trim().toLowerCase())
        if (pr.success) tag = pr.data
      }
      out.push(tag != null ? `[${tag}] ${hint}` : hint)
    }
  }
  return out
}

export const PostprocessOutputSchema = z.object({
  summary: z.string(),
  chapters: z.array(z.object({
    start: z.string(),
    end: z.string(),
    title: z.string(),
  })),
  examHints: z.preprocess(normalizeExamHints, z.array(z.string())),
  actionItems: z.array(z.string()),
})

export type PostprocessOutput = z.infer<typeof PostprocessOutputSchema>

export interface BudgetState {
  /** UTC calendar day `YYYY-MM-DD`; Groq Whisper **request** + Gemini counters reset at UTC midnight */
  date: string
  /** UTC hour bucket `YYYY-MM-DDTHH`; Groq **decoded audio** tally resets each new hour */
  groqAudioHourUtc: string
  /** Groq decoded-audio seconds used in the current UTC hour bucket */
  groqAudioSeconds: number
  /** Hourly cap (`GROQ_HOURLY_AUDIO_SECONDS`; default `7200` ≈ 2h audio per UTC hour; mirrors Groq ASH) */
  groqHourlyAudioLimit: number
  /** Groq decoded-audio seconds used this UTC calendar day (mirrors Groq ASD) */
  groqAudioSecondsToday: number
  /** Daily decoded-audio cap (`GROQ_DAILY_AUDIO_SECONDS`; default `28800` ≈ 8h/day) */
  groqDailyAudioLimit: number
  /** Whisper `transcriptions.create` calls this UTC calendar day */
  groqRequests: number
  groqDailyRequestLimit: number
  geminiRequests: number
  geminiDailyLimit: number
  /** `generateContent` calls this UTC day for Gemini-audio transcribe fallback only */
  geminiAudioRequests: number
  geminiAudioDailyLimit: number
}

export type QuotaResumeAfter = 'utc_hour' | 'utc_midnight'

/** Thrown when local budget or API quota blocks progress; callers may exit cleanly and retry on the next cron. */
export class QuotaError extends Error {
  constructor(
    public readonly provider: 'groq' | 'gemini',
    message?: string,
    public readonly resumeAfter: QuotaResumeAfter = 'utc_midnight',
  ) {
    super(`Quota exhausted on ${provider}: ${message ?? 'limit reached'}`)
    this.name = 'QuotaError'
  }
}

export function isQuotaError(e: unknown): e is QuotaError {
  return e instanceof QuotaError
}
