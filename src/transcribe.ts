import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'
import Groq from 'groq-sdk'
import type { BudgetTracker } from './budget'
import { mkdir } from 'node:fs/promises'
import { chunkOnSilence, getAudioDuration } from './download'
import { isQuotaError, QuotaError } from './types'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const CACHE_DIR = '.cache/transcripts'
const MAX_RETRIES = 5
const GEMINI_INLINE_MAX_MB = 16
/** 5 minutes — large base64 audio payloads on CI runners need time to upload + process. */
const GEMINI_AUDIO_TIMEOUT_MS = 5 * 60 * 1000

const GEMINI_AUDIO_RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    text: { type: SchemaType.STRING, description: 'Full verbatim transcript text' },
    segments: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          start: { type: SchemaType.STRING, description: 'Start time MM:SS or HH:MM:SS' },
          end: { type: SchemaType.STRING, description: 'End time MM:SS or HH:MM:SS' },
          text: { type: SchemaType.STRING },
        },
        required: ['start', 'end', 'text'] as string[],
      },
    },
    duration: { type: SchemaType.NUMBER, description: 'Chunk duration in seconds if known' },
  },
  required: ['text', 'segments'] as string[],
}

function geminiAudioModel(): string {
  const raw = (typeof process !== 'undefined' ? process.env.GEMINI_AUDIO_MODEL : '')?.trim()
  return raw && raw.length > 0 ? raw : 'gemini-2.5-flash'
}

function stripJsonFence(text: string): string {
  const t = text.trim()
  const m = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(t)
  return (m?.[1] ?? t).trim()
}

/** Parse Gemini segment timestamp: seconds number, MM:SS, or HH:MM:SS. */
export function parseSegmentTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  if (typeof value !== 'string') return 0
  const t = value.trim()
  const parts = t.split(':').map(p => parseFloat(p.trim()))
  if (parts.some(x => Number.isNaN(x))) return 0
  if (parts.length >= 3) {
    const h = parts[0] ?? 0
    const m = parts[1] ?? 0
    const s = parts[2] ?? 0
    return Math.max(0, h * 3600 + m * 60 + s)
  }
  if (parts.length >= 2) {
    const m = parts[0] ?? 0
    const s = parts[1] ?? 0
    return Math.max(0, m * 60 + s)
  }
  const n = parseFloat(t)
  return Number.isFinite(n) ? Math.max(0, n) : 0
}

async function geminiInlineData(audioPath: string): Promise<{ mimeType: string; data: string }> {
  const mimeType = 'audio/ogg'
  const buf = Buffer.from(await Bun.file(audioPath).arrayBuffer())
  const data = buf.toString('base64')
  const sizeMb = buf.length / (1024 * 1024)
  if (sizeMb > GEMINI_INLINE_MAX_MB + 0.5) {
    console.warn(`[transcribe] Gemini chunk ${sizeMb.toFixed(1)} MB > ${GEMINI_INLINE_MAX_MB} MB — upload may fail`)
  }
  return { mimeType, data }
}

function groqInterChunkDelayMs(): number {
  const raw = (typeof process !== 'undefined' ? process.env.GROQ_INTER_CHUNK_MS : '')?.trim()
  const n = raw ? Number(raw) : 0
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export type TranscriptionTier = 'best' | 'fast'

export type TranscribeProvider = 'groq' | 'gemini'

interface TranscriptionResult {
  text: string
  segments: Array<{ start: number; end: number; text: string }>
  duration: number
}

export async function transcribe(
  audioPath: string,
  lectureId: string,
  opts: {
    glossary?: string
    tier?: TranscriptionTier
    budget?: BudgetTracker
    provider?: TranscribeProvider
  } = {},
): Promise<TranscriptionResult> {
  const provider = opts.provider ?? 'groq'
  if (provider === 'gemini') {
    return transcribeViaGeminiAudio(audioPath, lectureId, opts)
  }

  await mkdir(CACHE_DIR, { recursive: true })

  const cachePath = `${CACHE_DIR}/${lectureId}.json`
  const cached = Bun.file(cachePath)
  if (await cached.exists()) {
    console.log(`[transcribe] Cache hit: ${lectureId}`)
    return cached.json()
  }

  const chunks = await chunkOnSilence(audioPath)
  const allSegments: TranscriptionResult['segments'] = []
  let fullText = ''
  let totalDuration = 0
  let timeOffset = 0

  const pauseMs = groqInterChunkDelayMs()

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0 && pauseMs > 0) await Bun.sleep(pauseMs)
    console.log(`[transcribe] Processing chunk ${i + 1}/${chunks.length}: ${chunks[i]}`)
    const chunkPath = chunks[i]
    const chunkSeconds = await getAudioDuration(chunkPath)
    const result = await transcribeChunkGroq(chunkPath, {
      glossary: opts.glossary,
      tier: opts.tier ?? 'best',
      budget: opts.budget,
    })

    fullText += (fullText ? ' ' : '') + result.text
    for (const seg of result.segments) {
      allSegments.push({
        start: seg.start + timeOffset,
        end: seg.end + timeOffset,
        text: seg.text,
      })
    }
    totalDuration += chunkSeconds
    timeOffset += chunkSeconds
  }

  const output: TranscriptionResult = {
    text: fullText,
    segments: allSegments,
    duration: totalDuration,
  }

  await Bun.write(cachePath, JSON.stringify(output, null, 2))
  console.log(`[transcribe] Cached: ${cachePath}`)

  return output
}

async function transcribeViaGeminiAudio(
  audioPath: string,
  lectureId: string,
  opts: { glossary?: string; budget?: BudgetTracker },
): Promise<TranscriptionResult> {
  const key = process.env.GEMINI_API_KEY
  if (!key?.trim()) throw new Error('GEMINI_API_KEY is required for Gemini audio transcription')

  await mkdir(CACHE_DIR, { recursive: true })

  const cachePath = `${CACHE_DIR}/${lectureId}.json`
  const cached = Bun.file(cachePath)
  if (await cached.exists()) {
    console.log(`[transcribe] Cache hit: ${lectureId}`)
    return cached.json()
  }

  const chunks = await chunkOnSilence(audioPath, GEMINI_INLINE_MAX_MB)
  const allSegments: TranscriptionResult['segments'] = []
  let fullText = ''
  let totalDuration = 0
  let timeOffset = 0

  const pauseMs = groqInterChunkDelayMs()

  const systemPreamble =
    `You are a verbatim speech-to-text transcriber for English academic lectures.\n`
    + `Rules:\n`
    + `- Output ONLY structured JSON matching the schema (via API). No preamble or markdown.\n`
    + `- Transcribe word-for-word. Do not summarize, omit, or "clean up" content.\n`
    + `- Language: English.\n`
    + `- Prefer segment boundaries roughly every ~30 seconds of speech; use chronological order.\n`
    + `- "start" and "end" for each segment MUST be timestamps relative to this audio chunk only, as strings in MM:SS or HH:MM:SS format.\n`
    + `- If a glossary/terms line is given, prefer those spellings when the audio matches:\n`

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0 && pauseMs > 0) await Bun.sleep(pauseMs)

    console.log(`[transcribe] Gemini-audio chunk ${i + 1}/${chunks.length}: ${chunks[i]}`)
    const chunkPath = chunks[i]
    const chunkSeconds = await getAudioDuration(chunkPath)

    const result = await transcribeGeminiChunk(chunkPath, {
      glossary: opts.glossary,
      budget: opts.budget,
      systemPreamble,
    })

    fullText += (fullText ? ' ' : '') + result.text.trim()
    for (const seg of result.segments) {
      const sStart = typeof (seg as { start?: unknown }).start !== 'undefined'
        ? parseSegmentTimestamp((seg as { start?: unknown }).start)
        : 0
      const sEnd = typeof (seg as { end?: unknown }).end !== 'undefined'
        ? parseSegmentTimestamp((seg as { end?: unknown }).end)
        : sStart
      allSegments.push({
        start: sStart + timeOffset,
        end: sEnd + timeOffset,
        text: typeof seg.text === 'string' ? seg.text : String(seg.text ?? ''),
      })
    }
    totalDuration += chunkSeconds
    timeOffset += chunkSeconds
  }

  const output: TranscriptionResult = {
    text: fullText,
    segments: allSegments,
    duration: totalDuration,
  }

  await Bun.write(cachePath, JSON.stringify(output, null, 2))
  console.log(`[transcribe] Cached: ${cachePath}`)

  return output
}

async function transcribeGeminiChunk(
  chunkPath: string,
  opts: { glossary?: string; budget?: BudgetTracker; systemPreamble: string },
): Promise<{ text: string; segments: Array<{ start?: unknown; end?: unknown; text: string }> }> {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
  const modelName = geminiAudioModel()

  let gloss = opts.glossary?.trim()
  gloss = gloss && gloss.length > 0 ? gloss : '(none)'

  const userText =
    opts.systemPreamble
    + `Glossary / terms (may be empty): ${gloss}\n\n`
    + `Transcribe the attached audio chunk.`

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (opts.budget && !opts.budget.canAffordGeminiAudio()) {
        throw new QuotaError('gemini', 'daily Gemini-audio request limit reached', 'utc_midnight')
      }

      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_AUDIO_RESPONSE_SCHEMA,
        },
      })

      const inline = await geminiInlineData(chunkPath)
      const result = await model.generateContent(
        [{ text: userText }, { inlineData: inline }],
        { timeout: GEMINI_AUDIO_TIMEOUT_MS },
      )

      opts.budget?.recordGeminiAudioRequest()

      const text = stripJsonFence(result.response.text())
      const parsed = JSON.parse(text) as {
        text?: string
        segments?: Array<{ start?: unknown; end?: unknown; text?: string }>
      }

      const segs = Array.isArray(parsed.segments) ? parsed.segments : []
      const normalized = segs.map(s => ({
        start: s.start,
        end: s.end,
        text: typeof s.text === 'string' ? s.text : '',
      }))

      return {
        text: typeof parsed.text === 'string' ? parsed.text : '',
        segments: normalized,
      }
    } catch (e: unknown) {
      if (isQuotaError(e)) throw e

      const err = e as { status?: number; message?: string }
      const msg = String(err?.message ?? e)

      const is429 = err?.status === 429 || msg.includes('429') || msg.toLowerCase().includes('quota')
      const isTransient = err?.status === 503
        || msg.toLowerCase().includes('timed out')
        || msg.toLowerCase().includes('timeout')
        || msg.toLowerCase().includes('econnreset')
        || msg.toLowerCase().includes('socket hang up')
        || msg.toLowerCase().includes('network')
        || msg.toLowerCase().includes('unavailable')

      if (is429 || isTransient) {
        if (attempt === MAX_RETRIES - 1) {
          if (is429) throw new QuotaError('gemini', 'Gemini-audio rate limit after all retries', 'utc_midnight')
          throw e
        }
        const delay = Math.pow(2, attempt) * (is429 ? 1000 : 2000)
        console.log(`[transcribe] Gemini ${is429 ? '429' : 'transient'} — retrying in ${delay}ms (${attempt + 1}/${MAX_RETRIES})`)
        await Bun.sleep(delay)
        continue
      }
      throw e
    }
  }

  throw new Error('Unreachable')
}

async function transcribeChunkGroq(
  chunkPath: string,
  opts: { glossary?: string; tier: TranscriptionTier; budget?: BudgetTracker },
): Promise<TranscriptionResult> {
  const model = opts.tier === 'fast' ? 'whisper-large-v3-turbo' : 'whisper-large-v3'

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (opts.budget && !opts.budget.canAffordGroqRequest()) {
        throw new QuotaError('groq', 'daily Whisper API request limit reached', 'utc_midnight')
      }

      const fileData = await Bun.file(chunkPath).arrayBuffer()
      const blob = new Blob([fileData], { type: 'audio/ogg' })
      const uploadFile = new File([blob], chunkPath.split('/').pop() ?? 'audio.opus') as any

      const response = await groq.audio.transcriptions.create({
        file: uploadFile,
        model,
        response_format: 'verbose_json',
        timestamp_granularities: ['segment'],
        language: 'en',
        prompt: opts.glossary,
        temperature: 0,
      })

      opts.budget?.recordGroqRequest()

      const segments = (response as any).segments?.map((s: any) => ({
        start: s.start,
        end: s.end,
        text: s.text,
      })) ?? []

      return {
        text: response.text,
        segments,
        duration: (response as any).duration ?? 0,
      }
    } catch (e: unknown) {
      if (isQuotaError(e)) throw e
      const er = e as { status?: number; error?: { code?: string } }
      if (er?.status === 429 || er?.error?.code === 'rate_limit_exceeded') {
        if (attempt === MAX_RETRIES - 1) {
          throw new QuotaError('groq', 'rate limit exceeded after all retries', 'utc_hour')
        }
        const delay = Math.pow(2, attempt) * 1000
        console.log(`[transcribe] 429 — retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`)
        await Bun.sleep(delay)
        continue
      }
      throw e
    }
  }

  throw new Error('Unreachable')
}