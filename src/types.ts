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

export type ExamHintPriority = z.infer<typeof examHintPriority>

function stringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean)
}

/** Gemini uses `{ hint, priority }`; legacy/plain strings → `general`. */
function normalizeExamHintsStructured(raw: unknown): Array<{ hint: string; priority: ExamHintPriority }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ hint: string; priority: ExamHintPriority }> = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const t = item.trim()
      if (t) out.push({ hint: t, priority: 'general' })
      continue
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      const hint = typeof o.hint === 'string' ? o.hint.trim() : ''
      if (!hint) continue
      let priority: ExamHintPriority = 'general'
      if (typeof o.priority === 'string') {
        const pr = examHintPriority.safeParse(o.priority.trim().toLowerCase())
        if (pr.success) priority = pr.data
      }
      out.push({ hint, priority })
    }
  }
  return out
}

function normalizeConnections(raw: unknown): { buildsOn: string[]; leadsTo: string[]; related: string[] } {
  if (!raw || typeof raw !== 'object')
    return { buildsOn: [], leadsTo: [], related: [] }
  const o = raw as Record<string, unknown>
  return {
    buildsOn: stringArray(o.buildsOn),
    leadsTo: stringArray(o.leadsTo),
    related: stringArray(o.related),
  }
}

/** Normalize missing keys / Gemma partial JSON before strict field validation. */
function coercePostprocessRaw(raw: unknown): unknown {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    tldr: typeof o.tldr === 'string' ? o.tldr : '',
    summary: typeof o.summary === 'string' ? o.summary : '',
    keyConcepts: Array.isArray(o.keyConcepts) ? o.keyConcepts : [],
    chapters: Array.isArray(o.chapters) ? o.chapters : [],
    deepDive: Array.isArray(o.deepDive) ? o.deepDive : [],
    formulas: Array.isArray(o.formulas) ? o.formulas : [],
    pitfalls: stringArray(o.pitfalls),
    examHints: normalizeExamHintsStructured(o.examHints),
    actionItems: stringArray(o.actionItems),
    connections: normalizeConnections(o.connections),
    selfCheck: Array.isArray(o.selfCheck) ? o.selfCheck : [],
    ankiCards: Array.isArray(o.ankiCards) ? o.ankiCards : [],
  }
}

const PostprocessInnerSchema = z.object({
  tldr: z.string(),
  summary: z.string(),
  keyConcepts: z.array(z.object({
    term: z.string(),
    definition: z.string(),
    whyItMatters: z.string().optional(),
  })),
  chapters: z.array(z.object({
    start: z.string(),
    end: z.string(),
    title: z.string(),
    takeaway: z.string().optional(),
  })),
  deepDive: z.array(z.object({
    topic: z.string(),
    whatItIs: z.string(),
    howItWorks: z.string(),
    whyItMatters: z.string().optional(),
    example: z.string().optional(),
  })),
  formulas: z.array(z.object({
    name: z.string(),
    expression: z.string(),
    notes: z.string().optional(),
  })),
  pitfalls: z.array(z.string()),
  examHints: z.array(z.object({
    hint: z.string(),
    priority: examHintPriority,
  })),
  actionItems: z.array(z.string()),
  connections: z.object({
    buildsOn: z.array(z.string()),
    leadsTo: z.array(z.string()),
    related: z.array(z.string()),
  }),
  selfCheck: z.array(z.object({
    question: z.string(),
    answer: z.string(),
  })),
  ankiCards: z.array(z.object({
    type: z.enum(['mc', 'basic', 'cloze']),
    front: z.string(),
    options: z.array(z.string()).optional(),
    correct: z.number().optional(),
    back: z.string(),
    tags: z.array(z.string()),
  })),
})

export const PostprocessOutputSchema = z.preprocess(coercePostprocessRaw, PostprocessInnerSchema).transform(data => ({
  ...data,
  keyConcepts: data.keyConcepts.map(k => ({
    term: k.term,
    definition: k.definition,
    whyItMatters: k.whyItMatters?.trim() ?? '',
  })),
  chapters: data.chapters.map(c => ({
    start: c.start,
    end: c.end,
    title: c.title,
    takeaway: c.takeaway?.trim() ?? '',
  })),
  deepDive: data.deepDive.map(d => ({
    topic: d.topic,
    whatItIs: d.whatItIs,
    howItWorks: d.howItWorks,
    whyItMatters: d.whyItMatters?.trim() ?? '',
    example: d.example?.trim() ?? '',
  })),
  formulas: data.formulas.map(f => ({
    name: f.name,
    expression: f.expression,
    notes: f.notes?.trim() ?? '',
  })),
  ankiCards: data.ankiCards,
}))

export type PostprocessOutput = z.infer<typeof PostprocessOutputSchema>

export interface AnkiCard {
  type: 'mc' | 'basic' | 'cloze'
  front: string
  options?: string[]
  correct?: number
  back: string
  tags: string[]
}

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
