import Groq from 'groq-sdk'
import type { BudgetTracker } from './budget'
import { mkdir } from 'node:fs/promises'
import { chunkOnSilence, getAudioDuration } from './download'
import { QuotaError } from './types'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const CACHE_DIR = '.cache/transcripts'
const MAX_RETRIES = 5

function groqInterChunkDelayMs(): number {
  const raw = (typeof process !== 'undefined' ? process.env.GROQ_INTER_CHUNK_MS : '')?.trim()
  const n = raw ? Number(raw) : 0
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export type TranscriptionTier = 'best' | 'fast'

interface TranscriptionResult {
  text: string
  segments: Array<{ start: number; end: number; text: string }>
  duration: number
}

export async function transcribe(
  audioPath: string,
  lectureId: string,
  opts: { glossary?: string; tier?: TranscriptionTier; budget?: BudgetTracker } = {},
): Promise<TranscriptionResult> {
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
    const result = await transcribeChunk(chunkPath, {
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

async function transcribeChunk(
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
    } catch (e: any) {
      if (e?.status === 429 || e?.error?.code === 'rate_limit_exceeded') {
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
