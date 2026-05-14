import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'
import { PostprocessOutputSchema, isQuotaError, QuotaError, type PostprocessOutput } from './types'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING, description: 'Concise 2-3 paragraph summary of the lecture content' },
    chapters: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          start: { type: SchemaType.STRING, description: 'Start timestamp (HH:MM:SS or MM:SS)' },
          end: { type: SchemaType.STRING, description: 'End timestamp (HH:MM:SS or MM:SS)' },
          title: { type: SchemaType.STRING, description: 'Chapter title' },
        },
        required: ['start', 'end', 'title'] as string[],
      },
    },
    examHints: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: 'Key points likely to appear on exams',
    },
    actionItems: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description: 'Homework, readings, or tasks mentioned by the lecturer',
    },
  },
  required: ['summary', 'chapters', 'examHints', 'actionItems'] as string[],
}

const SYSTEM_PROMPT = `You are a university lecture note assistant. Given a transcript of a lecture, produce structured notes.

Rules:
- Summary: 2-3 paragraphs covering the main topics and key takeaways
- Chapters: logical sections with timestamps from the transcript segments
- Exam hints: concepts the lecturer emphasizes, repeats, or explicitly marks as exam-relevant
- Action items: homework assignments, readings, deadlines, or tasks mentioned

Be precise and factual. Do not hallucinate content not in the transcript.`

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'] as const

export interface PostprocessOptions {
  /** Run before each `generateContent`; throw to abort when over budget */
  beforeGeminiRequest?: () => void
  /** After each completed `generateContent` (counts 1 retry as a second request) */
  onGeminiRequest?: () => void
}

export async function postprocess(transcript: string, opts?: PostprocessOptions): Promise<PostprocessOutput> {
  for (const modelName of MODELS) {
    try {
      const result = await callGemini(modelName, transcript, opts)
      return result
    } catch (e: unknown) {
      if (isQuotaError(e)) throw e
      const err = e as { status?: number; message?: string }
      if (err?.status === 429 || err?.message?.includes('429') || err?.message?.includes('quota')) {
        if (modelName === MODELS[MODELS.length - 1]) {
          throw new QuotaError('gemini', 'all models exhausted', 'utc_midnight')
        }
        console.log(`[postprocess] 429 on ${modelName}, falling back to next model...`)
        continue
      }
      throw e
    }
  }

  throw new Error('Unreachable')
}

async function callGemini(modelName: string, transcript: string, callbacks?: PostprocessOptions): Promise<PostprocessOutput> {
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  })

  console.log(`[postprocess] Calling ${modelName}...`)
  callbacks?.beforeGeminiRequest?.()
  const result = await model.generateContent(SYSTEM_PROMPT + '\n\n--- TRANSCRIPT ---\n\n' + transcript)
  callbacks?.onGeminiRequest?.()
  const text = result.response.text()
  const parsed = JSON.parse(text)

  // Zod validation for defense in depth
  const validated = PostprocessOutputSchema.safeParse(parsed)
  if (!validated.success) {
    console.warn(`[postprocess] Schema validation failed on first attempt, retrying with stricter prompt...`)
    // Retry once with emphasis on required fields
    callbacks?.beforeGeminiRequest?.()
    const retryResult = await model.generateContent(
      SYSTEM_PROMPT +
      '\n\nCRITICAL: You MUST include non-empty values for summary, chapters, examHints, and actionItems. Do not return empty arrays.' +
      '\n\n--- TRANSCRIPT ---\n\n' + transcript,
    )
    callbacks?.onGeminiRequest?.()
    const retryText = retryResult.response.text()
    const retryParsed = JSON.parse(retryText)
    const retryValidated = PostprocessOutputSchema.parse(retryParsed)
    return retryValidated
  }

  return validated.data
}
