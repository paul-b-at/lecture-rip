import Groq from 'groq-sdk'
import { $ } from 'bun'
import path from 'node:path'
import { mkdir, unlink } from 'node:fs/promises'
import type { BudgetTracker } from './budget'
import { chunkByMaxDuration, chunkOnSilence, getAudioDuration } from './download'
import { isQuotaError, QuotaError } from './types'

let groqClient: Groq | null = null
function groq(): Groq {
  const key = process.env.GROQ_API_KEY
  if (!key?.trim())
    throw new Error('GROQ_API_KEY is required for Groq transcription (omit --local / TRANSCRIBE_LOCAL or set the key).')
  groqClient ??= new Groq({ apiKey: key })
  return groqClient
}

const CACHE_DIR = '.cache/transcripts'
const MAX_RETRIES = 5

function groqInterChunkDelayMs(): number {
  const raw = (typeof process !== 'undefined' ? process.env.GROQ_INTER_CHUNK_MS : '')?.trim()
  const n = raw ? Number(raw) : 0
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export type TranscriptionTier = 'best' | 'fast'

/** Transcription backend: Groq cloud API or local whisper.cpp CLI (`WHISPER_MODEL_PATH`). */
export type TranscriptionProvider = 'groq' | 'local'

interface TranscriptionResult {
  text: string
  segments: Array<{ start: number; end: number; text: string }>
  duration: number
}

export interface TranscribeOptions {
  glossary?: string
  tier?: TranscriptionTier
  budget?: BudgetTracker
  provider?: TranscriptionProvider
}

function transcribeLocalEnabled(opts: TranscribeOptions): boolean {
  return opts.provider === 'local'
}

/** Max minutes per local `whisper-cli` run (`WHISPER_CHUNK_MINUTES`; default 12). Set 0 to disable. */
function whisperLocalChunkMinutes(): number {
  const raw = (process.env.WHISPER_CHUNK_MINUTES ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
    return 0
  const n = raw.length > 0 ? Number(raw) : 12
  return Number.isFinite(n) && n > 0 ? n : 12
}

async function prepareTranscriptionChunks(audioPath: string, opts: TranscribeOptions): Promise<string[]> {
  let chunks = await chunkOnSilence(audioPath)

  if (!transcribeLocalEnabled(opts))
    return chunks

  const maxMin = whisperLocalChunkMinutes()
  if (maxMin <= 0)
    return chunks

  const expanded: string[] = []
  for (const c of chunks)
    expanded.push(...await chunkByMaxDuration(c, maxMin))

  if (expanded.length > chunks.length) {
    console.log(
      `[transcribe] Local time-chunking: ${chunks.length} file(s) → ${expanded.length} parts (≤${maxMin} min each)`,
    )
  }

  return expanded
}

function whisperCli(): string {
  const t = (process.env.WHISPER_CLI ?? '').trim()
  /** Homebrew `brew install whisper-cpp` installs `whisper-cli` in `$(brew --prefix whisper-cpp)/bin`, not `whisper-cpp`. */
  return t.length > 0 ? t : 'whisper-cli'
}

function whisperModelPath(): string {
  const t = (process.env.WHISPER_MODEL_PATH ?? '').trim()
  if (!t)
    throw new Error(
      'Local transcription requires WHISPER_MODEL_PATH (path to ggml/gguf Whisper model, e.g. ggml-large-v3.bin). '
      + `Install whisper-cpp (\`brew install whisper-cpp\`) and download a compatible model.`,
    )
  return t
}

/** Extra CLI args appended after language (space-separated tokens). */
function whisperExtraArgs(): string[] {
  const raw = (process.env.WHISPER_EXTRA_ARGS ?? '').trim()
  if (!raw) return []
  return raw.split(/\s+/).filter(Boolean)
}

/** Collect segment-like objects from whisper-cli `-oj` JSON (`transcription[]`) or OpenAI-style `segments[]`. */
function whisperJsonSegmentItems(json: unknown): unknown[] {
  const collect = (node: unknown): unknown[] => {
    if (!node || typeof node !== 'object') return []
    const o = node as Record<string, unknown>
    const out: unknown[] = []
    if (Array.isArray(o.transcription)) out.push(...o.transcription)
    if (Array.isArray(o.segments)) out.push(...o.segments)
    return out
  }

  const root = json && typeof json === 'object' ? (json as Record<string, unknown>) : {}
  const items = [...collect(json)]
  if (items.length === 0 && root.result != null)
    items.push(...collect(root.result))
  return items
}

function parseWhisperSegmentTimes(o: Record<string, unknown>): { start: number; end: number } {
  let start = typeof o.start === 'number' ? o.start : Number.NaN
  let end = typeof o.end === 'number' ? o.end : Number.NaN

  const offsets = o.offsets
  if ((!Number.isFinite(start) || !Number.isFinite(end)) && offsets && typeof offsets === 'object') {
    const off = offsets as Record<string, unknown>
    const fromMs = typeof off.from === 'number' ? off.from : typeof off.from === 'string' ? Number(off.from) : Number.NaN
    const toMs = typeof off.to === 'number' ? off.to : typeof off.to === 'string' ? Number(off.to) : Number.NaN
    if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
      start = fromMs / 1000
      end = toMs / 1000
    }
  }

  return { start, end }
}

/** Merge whisper JSON into normalized `{ start, end, text }` in seconds (float). */
function normalizeWhisperSegments(json: unknown): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = []
  for (const s of whisperJsonSegmentItems(json)) {
    if (!s || typeof s !== 'object') continue
    const o = s as Record<string, unknown>
    const textRaw = typeof o.text === 'string' ? o.text.trim() : ''
    if (!textRaw) continue

    const { start, end } = parseWhisperSegmentTimes(o)
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      out.push({ start: 0, end: 0, text: textRaw })
      continue
    }
    out.push({ start, end, text: textRaw })
  }
  return out
}

function extractWhisperFullText(json: unknown, segments: Array<{ text: string }>): string {
  const root = json && typeof json === 'object' ? (json as Record<string, unknown>) : {}
  if (typeof root.text === 'string' && root.text.trim())
    return root.text.trim()

  const result = root.result
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>
    if (typeof r.text === 'string' && r.text.trim())
      return r.text.trim()
  }

  const fromItems = whisperJsonSegmentItems(json)
    .map(s => (s && typeof s === 'object' && typeof (s as Record<string, unknown>).text === 'string'
      ? String((s as Record<string, unknown>).text).trim()
      : ''))
    .filter(Boolean)
  if (fromItems.length > 0)
    return fromItems.join(' ').trim()

  if (segments.length > 0)
    return segments.map(s => s.text).join(' ').trim()

  return ''
}

function assertTranscriptNotEmpty(text: string, context: string): void {
  if (text.trim().length > 0) return
  throw new Error(
    `${context}: transcription produced no text. `
    + 'Check audio level, model path, and delete stale `.cache/transcripts/<lectureId>.local.json` if re-running.',
  )
}

async function transcribeChunkLocal(chunkPath: string, opts: { glossary?: string }): Promise<TranscriptionResult> {
  const cli = whisperCli()
  const model = whisperModelPath()
  const tmpDir = path.join('tmp', 'whisper-local')
  await mkdir(tmpDir, { recursive: true })

  const base = path.basename(chunkPath).replace(/\.[^.]+$/, '') || 'chunk'
  const wavPath = path.join(tmpDir, `${base}_${Date.now()}.wav`)
  const outPrefix = path.join(tmpDir, `${base}_${Date.now()}_out`)

  try {
    const ff = await $`ffmpeg -y -i ${chunkPath} -ar 16000 -ac 1 -c:a pcm_s16le ${wavPath}`.quiet()
    if (ff.exitCode !== 0)
      throw new Error(`ffmpeg WAV conversion failed: ${ff.stderr.toString()}`)

    const extra = whisperExtraArgs()
    const glossary = (opts.glossary ?? '').trim()

    const proc = Bun.spawn({
      cmd: [
        cli,
        '-m',
        model,
        '-f',
        wavPath,
        '-l',
        'en',
        '-oj',
        '-of',
        outPrefix,
        ...(glossary.length > 0 ? ['--prompt', glossary] : []),
        ...extra,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const code = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    if (code !== 0)
      throw new Error(
        `${cli} exited ${code}. stderr:\n${stderr.slice(-4000)}\n`
        + `Hint: Homebrew installs \`whisper-cli\` (set WHISPER_CLI to its full path if not on PATH).`,
      )

    const jsonPath = `${outPrefix}.json`
    const jf = Bun.file(jsonPath)
    if (!(await jf.exists()))
      throw new Error(`Expected Whisper JSON at ${jsonPath} — check whisper-cpp supports -oj / JSON output.`)

    const parsed: unknown = await jf.json()
    const segments = normalizeWhisperSegments(parsed)
    const fullText = extractWhisperFullText(parsed, segments)
    assertTranscriptNotEmpty(fullText, 'whisper-cli')

    const chunkDur = await getAudioDuration(chunkPath)

    return {
      text: fullText,
      segments,
      duration: chunkDur,
    }
  }
  finally {
    await unlink(wavPath).catch(() => {})
    await unlink(`${outPrefix}.json`).catch(() => {})
    await unlink(`${outPrefix}.txt`).catch(() => {})
    await unlink(`${outPrefix}.vtt`).catch(() => {})
  }
}

export async function transcribe(
  audioPath: string,
  lectureId: string,
  opts: TranscribeOptions = {},
): Promise<TranscriptionResult> {
  await mkdir(CACHE_DIR, { recursive: true })

  const provider: TranscriptionProvider = opts.provider ?? 'groq'
  const cachePath = `${CACHE_DIR}/${lectureId}.${provider}.json`
  const cached = Bun.file(cachePath)
  if (await cached.exists()) {
    const hit = await cached.json() as TranscriptionResult
    if (hit.text?.trim()) {
      console.log(`[transcribe] Cache hit: ${lectureId} (${provider})`)
      return hit
    }
    console.warn(`[transcribe] Ignoring empty cache ${cachePath} — re-transcribing`)
  }
  /** Older pipeline versions used `.cache/transcripts/<id>.json` (Groq only). */
  if (provider === 'groq') {
    const legacy = Bun.file(`${CACHE_DIR}/${lectureId}.json`)
    if (await legacy.exists()) {
      console.log(`[transcribe] Legacy cache hit: ${lectureId}.json (Groq)`)
      return legacy.json() as Promise<TranscriptionResult>
    }
  }

  const chunks = await prepareTranscriptionChunks(audioPath, opts)
  const allSegments: TranscriptionResult['segments'] = []
  let fullText = ''
  let totalDuration = 0
  let timeOffset = 0

  const pauseMs = groqInterChunkDelayMs()
  const local = transcribeLocalEnabled(opts)

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0 && pauseMs > 0 && !local) await Bun.sleep(pauseMs)
    console.log(`[transcribe] (${provider}) chunk ${i + 1}/${chunks.length}: ${chunks[i]}`)
    const chunkPath = chunks[i]
    const chunkSeconds = await getAudioDuration(chunkPath)

    const result = local
      ? await transcribeChunkLocal(chunkPath, { glossary: opts.glossary })
      : await transcribeChunkGroq(chunkPath, {
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

  assertTranscriptNotEmpty(output.text, `transcribe(${lectureId})`)

  await Bun.write(cachePath, JSON.stringify(output, null, 2))
  console.log(`[transcribe] Cached: ${cachePath}`)

  return output
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

      const response = await groq().audio.transcriptions.create({
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
    }
    catch (e: unknown) {
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
