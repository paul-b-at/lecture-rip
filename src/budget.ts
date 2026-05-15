import { mkdir } from 'node:fs/promises'
import type { BudgetState } from './types'

const BUDGET_PATH = '.cache/budget.json'

/** Groq decoded-audio capped per UTC **hour** bucket; default matches Groq ASH for whisper-large-v3 (~7200 ≈ 2h). Check console.groq.com */
const DEFAULT_GROQ_HOURLY_AUDIO_SECONDS = 7200
/** Whisper `transcriptions.create` RPD; Groq Developer base tier whisper-large-v3 shows 2000. */
const DEFAULT_GROQ_DAILY_REQUESTS = 2000
/** Groq ASD (audio seconds per day) for whisper-large-v3 on Developer base tier. */
const DEFAULT_GROQ_DAILY_AUDIO_SECONDS = 28800
/** Postprocess `generateContent` cap (logical carve-out of per-project Gemini RPD). */
const DEFAULT_GEMINI_DAILY_REQUESTS = 300
/** Gemini-audio transcribe fallback cap (`generateContent`; same Gemini project pool). */
const DEFAULT_GEMINI_AUDIO_DAILY_REQUESTS = 200
const DOWNSHIFT_THRESHOLD = 0.8

function utcCalendarDay(): string {
  return new Date().toISOString().slice(0, 10)
}

/** e.g. `2026-05-14T19` UTC — decoded-audio bookkeeping rolls over each new hour */
function utcHourBucket(): string {
  return new Date().toISOString().slice(0, 13)
}

function parsedGroqHourlyAudioSecondsCap(): number {
  if (typeof process === 'undefined') return DEFAULT_GROQ_HOURLY_AUDIO_SECONDS
  const raw = process.env.GROQ_HOURLY_AUDIO_SECONDS?.trim()
    ?? process.env.GROQ_HOUR_AUDIO_SECONDS?.trim()
    ?? process.env.GROQ_DIALY_AUDIO_SECONDS?.trim()
    ?? ''
  if (!raw) return DEFAULT_GROQ_HOURLY_AUDIO_SECONDS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GROQ_HOURLY_AUDIO_SECONDS
}

function parsedGroqDailyAudioSecondsCap(): number {
  if (typeof process === 'undefined') return DEFAULT_GROQ_DAILY_AUDIO_SECONDS
  const raw = process.env.GROQ_DAILY_AUDIO_SECONDS?.trim() ?? ''
  if (!raw) return DEFAULT_GROQ_DAILY_AUDIO_SECONDS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GROQ_DAILY_AUDIO_SECONDS
}

function parsedGroqDailyRequestLimit(): number {
  if (typeof process === 'undefined') return DEFAULT_GROQ_DAILY_REQUESTS
  const raw = process.env.GROQ_DAILY_REQUESTS?.trim()
    ?? process.env.GROQ_DIALY_REQUESTS?.trim()
    ?? ''
  if (!raw) return DEFAULT_GROQ_DAILY_REQUESTS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GROQ_DAILY_REQUESTS
}

function parsedGeminiDailyRequestLimit(): number {
  if (typeof process === 'undefined') return DEFAULT_GEMINI_DAILY_REQUESTS
  const raw = process.env.GEMINI_DAILY_REQUESTS?.trim()
    ?? process.env.GEMINI_DIALY_REQUESTS?.trim()
    ?? ''
  if (!raw) return DEFAULT_GEMINI_DAILY_REQUESTS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GEMINI_DAILY_REQUESTS
}

function parsedGeminiAudioDailyRequestLimit(): number {
  if (typeof process === 'undefined') return DEFAULT_GEMINI_AUDIO_DAILY_REQUESTS
  const raw = process.env.GEMINI_AUDIO_DAILY_REQUESTS?.trim() ?? ''
  if (!raw) return DEFAULT_GEMINI_AUDIO_DAILY_REQUESTS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_GEMINI_AUDIO_DAILY_REQUESTS
}

function roundGroqSeconds(n: number): number {
  return Math.max(0, Math.round(Number(n)))
}

const HOUR_BUCKET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}$/

/** Pessimistic chunk count for Gemini audio STT from duration (16MB chunks @ ~32kbps opus ≈ long segments). */
export function estimatedGeminiTranscribeRequestsForDuration(audioSeconds: number): number {
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) return 1
  return Math.max(1, Math.ceil(audioSeconds / 600))
}

function migratePersistedBudget(raw: unknown): BudgetState {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}

  let date =
    typeof obj.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.date)
      ? obj.date
      : utcCalendarDay()
  let groqRequests = typeof obj.groqRequests === 'number' ? Math.max(0, Math.floor(obj.groqRequests)) : 0
  let geminiRequests = typeof obj.geminiRequests === 'number' ? Math.max(0, Math.floor(obj.geminiRequests)) : 0
  let groqAudioSecondsToday = typeof obj.groqAudioSecondsToday === 'number' ? roundGroqSeconds(obj.groqAudioSecondsToday) : 0
  let geminiAudioRequests = typeof obj.geminiAudioRequests === 'number' ? Math.max(0, Math.floor(obj.geminiAudioRequests)) : 0

  const today = utcCalendarDay()
  if (date !== today) {
    date = today
    groqRequests = 0
    geminiRequests = 0
    groqAudioSecondsToday = 0
    geminiAudioRequests = 0
  }

  const hourBucketNow = utcHourBucket()
  let groqAudioHourUtc =
    typeof obj.groqAudioHourUtc === 'string' && HOUR_BUCKET_RE.test(obj.groqAudioHourUtc)
      ? obj.groqAudioHourUtc
      : ''
  let groqAudioSeconds = typeof obj.groqAudioSeconds === 'number' ? roundGroqSeconds(obj.groqAudioSeconds) : 0

  if (!groqAudioHourUtc || groqAudioHourUtc !== hourBucketNow) {
    groqAudioSeconds = 0
    groqAudioHourUtc = hourBucketNow
  }

  return {
    date,
    groqAudioHourUtc,
    groqAudioSeconds,
    groqHourlyAudioLimit: parsedGroqHourlyAudioSecondsCap(),
    groqAudioSecondsToday,
    groqDailyAudioLimit: parsedGroqDailyAudioSecondsCap(),
    groqRequests,
    groqDailyRequestLimit: parsedGroqDailyRequestLimit(),
    geminiRequests,
    geminiDailyLimit: parsedGeminiDailyRequestLimit(),
    geminiAudioRequests,
    geminiAudioDailyLimit: parsedGeminiAudioDailyRequestLimit(),
  }
}

function freshBudgetState(): BudgetState {
  return {
    date: utcCalendarDay(),
    groqAudioHourUtc: utcHourBucket(),
    groqAudioSeconds: 0,
    groqHourlyAudioLimit: parsedGroqHourlyAudioSecondsCap(),
    groqAudioSecondsToday: 0,
    groqDailyAudioLimit: parsedGroqDailyAudioSecondsCap(),
    groqRequests: 0,
    groqDailyRequestLimit: parsedGroqDailyRequestLimit(),
    geminiRequests: 0,
    geminiDailyLimit: parsedGeminiDailyRequestLimit(),
    geminiAudioRequests: 0,
    geminiAudioDailyLimit: parsedGeminiAudioDailyRequestLimit(),
  }
}

export class BudgetTracker {
  private state: BudgetState

  private constructor(state: BudgetState) {
    this.state = state
  }

  static async load(): Promise<BudgetTracker> {
    await mkdir('.cache', { recursive: true })
    const file = Bun.file(BUDGET_PATH)

    if (await file.exists()) {
      try {
        const raw: unknown = await file.json()
        return new BudgetTracker(migratePersistedBudget(raw))
      } catch {
        return new BudgetTracker(freshBudgetState())
      }
    }

    return new BudgetTracker(freshBudgetState())
  }

  async save(): Promise<void> {
    this.state.groqAudioSeconds = roundGroqSeconds(this.state.groqAudioSeconds)
    this.state.groqAudioSecondsToday = roundGroqSeconds(this.state.groqAudioSecondsToday)
    await Bun.write(BUDGET_PATH, JSON.stringify(this.state, null, 2))
  }

  /** Reconcile env caps with disk state (handles long-running scripts crossing UTC midnight or hour) */
  tickClock(): void {
    const today = utcCalendarDay()
    const hourBucket = utcHourBucket()
    const hourlyLimit = parsedGroqHourlyAudioSecondsCap()
    const groqDailyAudio = parsedGroqDailyAudioSecondsCap()
    const groqReqLimit = parsedGroqDailyRequestLimit()
    const gemLimit = parsedGeminiDailyRequestLimit()
    const gemAudioLimit = parsedGeminiAudioDailyRequestLimit()

    if (this.state.date !== today) {
      this.state.date = today
      this.state.groqRequests = 0
      this.state.geminiRequests = 0
      this.state.groqAudioSecondsToday = 0
      this.state.geminiAudioRequests = 0
    }

    if (this.state.groqAudioHourUtc !== hourBucket) {
      this.state.groqAudioHourUtc = hourBucket
      this.state.groqAudioSeconds = 0
    }

    this.state.groqHourlyAudioLimit = hourlyLimit
    this.state.groqDailyAudioLimit = groqDailyAudio
    this.state.groqDailyRequestLimit = groqReqLimit
    this.state.geminiDailyLimit = gemLimit
    this.state.geminiAudioDailyLimit = gemAudioLimit
  }

  shouldDownshiftGroq(): boolean {
    this.tickClock()
    return this.state.groqAudioSeconds >= this.state.groqHourlyAudioLimit * DOWNSHIFT_THRESHOLD
  }

  canAffordGroq(estimatedSeconds: number): boolean {
    this.tickClock()
    const s = Math.max(0, Math.ceil(Number(estimatedSeconds)))
    const fitsHour =
      this.state.groqAudioSeconds + s <= this.state.groqHourlyAudioLimit
    const fitsDay =
      this.state.groqAudioSecondsToday + s <= this.state.groqDailyAudioLimit
    return fitsHour && fitsDay
  }

  canAffordGroqRequest(): boolean {
    this.tickClock()
    return this.state.groqRequests < this.state.groqDailyRequestLimit
  }

  canAffordGemini(): boolean {
    this.tickClock()
    return this.state.geminiRequests < this.state.geminiDailyLimit
  }

  canAffordGeminiAudio(): boolean {
    this.tickClock()
    return this.state.geminiAudioRequests < this.state.geminiAudioDailyLimit
  }

  /** Whether enough Gemini-audio request budget remains for transcribing roughly `estimatedSeconds` of lecture audio. */
  canAffordGeminiTranscriptionForDuration(estimatedSeconds: number): boolean {
    this.tickClock()
    const needed = estimatedGeminiTranscribeRequestsForDuration(estimatedSeconds)
    return this.state.geminiAudioRequests + needed <= this.state.geminiAudioDailyLimit
  }

  recordGroqUsage(audioSeconds: number): void {
    this.tickClock()
    const s = roundGroqSeconds(audioSeconds)
    this.state.groqAudioSeconds = roundGroqSeconds(this.state.groqAudioSeconds + s)
    this.state.groqAudioSecondsToday = roundGroqSeconds(this.state.groqAudioSecondsToday + s)
  }

  recordGroqRequest(): void {
    this.tickClock()
    this.state.groqRequests++
  }

  recordGeminiUsage(): void {
    this.tickClock()
    this.state.geminiRequests++
  }

  recordGeminiAudioRequest(): void {
    this.tickClock()
    this.state.geminiAudioRequests++
  }

  /** Groq Whisper path covers encoding + request budget for this lecture duration. */
  groqCoversTranscription(estimatedSeconds: number): boolean {
    return this.canAffordGroqRequest() && this.canAffordGroq(estimatedSeconds)
  }

  get groqRemaining(): number {
    this.tickClock()
    return Math.max(0, this.state.groqHourlyAudioLimit - this.state.groqAudioSeconds)
  }

  get groqDailyAudioRemaining(): number {
    this.tickClock()
    return Math.max(0, this.state.groqDailyAudioLimit - this.state.groqAudioSecondsToday)
  }

  get geminiRemaining(): number {
    this.tickClock()
    return Math.max(0, this.state.geminiDailyLimit - this.state.geminiRequests)
  }

  get geminiAudioRemaining(): number {
    this.tickClock()
    return Math.max(0, this.state.geminiAudioDailyLimit - this.state.geminiAudioRequests)
  }

  summary(): string {
    this.tickClock()
    const g = Math.round(this.state.groqAudioSeconds)
    const gd = Math.round(this.state.groqAudioSecondsToday)
    return `Groq: ${g}s / ${this.state.groqHourlyAudioLimit}s (hour ${this.state.groqAudioHourUtc}), `
      + `${gd}s / ${this.state.groqDailyAudioLimit}s/day, `
      + `${this.state.groqRequests}/${this.state.groqDailyRequestLimit} Whisper reqs/day | `
      + `Gemini: ${this.state.geminiRequests} / ${this.state.geminiDailyLimit} (postproc) reqs/day | `
      + `Gemini-audio: ${this.state.geminiAudioRequests} / ${this.state.geminiAudioDailyLimit} reqs/day`
  }
}
