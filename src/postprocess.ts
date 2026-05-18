import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'
import { PostprocessOutputSchema, isQuotaError, QuotaError, type PostprocessOutput } from './types'

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

const RESPONSE_SCHEMA = {
	type: SchemaType.OBJECT,
	properties: {
		tldr: {
			type: SchemaType.STRING,
			description: '2-3 sentence elevator pitch of the whole lecture. The single most important takeaway.',
		},
		summary: {
			type: SchemaType.STRING,
			description: 'Concise 2-3 paragraph summary of the lecture content',
		},
		keyConcepts: {
			type: SchemaType.ARRAY,
			description: '5-8 named concepts/terms introduced or emphasized in the lecture',
			items: {
				type: SchemaType.OBJECT,
				properties: {
					term: { type: SchemaType.STRING, description: 'Concept or term name' },
					definition: { type: SchemaType.STRING, description: 'One-line definition' },
					whyItMatters: { type: SchemaType.STRING, description: 'Why this concept is relevant or where it is used' },
				},
				required: ['term', 'definition'] as string[],
			},
		},
		chapters: {
			type: SchemaType.ARRAY,
			items: {
				type: SchemaType.OBJECT,
				properties: {
					start: { type: SchemaType.STRING, description: 'Start timestamp (HH:MM:SS or MM:SS)' },
					end: { type: SchemaType.STRING, description: 'End timestamp (HH:MM:SS or MM:SS)' },
					title: { type: SchemaType.STRING, description: 'Chapter title' },
					takeaway: { type: SchemaType.STRING, description: 'One-line takeaway for this chapter' },
				},
				required: ['start', 'end', 'title', 'takeaway'] as string[],
			},
		},
		deepDive: {
			type: SchemaType.ARRAY,
			description: 'Topic-by-topic breakdown of the meat of the lecture (not bound to timestamps)',
			items: {
				type: SchemaType.OBJECT,
				properties: {
					topic: { type: SchemaType.STRING, description: 'Topic name' },
					whatItIs: { type: SchemaType.STRING, description: 'Definition / framing' },
					howItWorks: { type: SchemaType.STRING, description: 'Mechanism, steps, or pseudocode explanation' },
					whyItMatters: { type: SchemaType.STRING, description: 'When you would use it, tradeoffs, significance' },
					example: { type: SchemaType.STRING, description: 'Worked example or concrete instance, if given in the lecture' },
				},
				required: ['topic', 'whatItIs', 'howItWorks'] as string[],
			},
		},
		formulas: {
			type: SchemaType.ARRAY,
			description: 'Formulas, theorems, and precise definitions worth putting on a cheat sheet',
			items: {
				type: SchemaType.OBJECT,
				properties: {
					name: { type: SchemaType.STRING, description: 'Name of the formula/theorem/definition' },
					expression: { type: SchemaType.STRING, description: 'The formula or precise statement (LaTeX-friendly plain text)' },
					notes: { type: SchemaType.STRING, description: 'Conditions, variables, or context' },
				},
				required: ['name', 'expression'] as string[],
			},
		},
		pitfalls: {
			type: SchemaType.ARRAY,
			items: { type: SchemaType.STRING },
			description: 'Counterintuitive points, common mistakes, or things the lecturer explicitly warned about',
		},
		examHints: {
			type: SchemaType.ARRAY,
			items: {
				type: SchemaType.OBJECT,
				properties: {
					hint: { type: SchemaType.STRING, description: 'The exam-relevant point' },
					priority: {
						type: SchemaType.STRING,
						description: 'How strongly the lecturer signaled this',
						enum: ['likely', 'tricky', 'general'],
					},
				},
				required: ['hint', 'priority'] as string[],
			},
			description: 'Key points likely to appear on exams, tagged by signal strength',
		},
		actionItems: {
			type: SchemaType.ARRAY,
			items: { type: SchemaType.STRING },
			description: 'Homework, readings, or tasks mentioned by the lecturer',
		},
		connections: {
			type: SchemaType.OBJECT,
			description: 'How this lecture links to other material',
			properties: {
				buildsOn: {
					type: SchemaType.ARRAY,
					items: { type: SchemaType.STRING },
					description: 'Prerequisite topics or earlier lectures referenced',
				},
				leadsTo: {
					type: SchemaType.ARRAY,
					items: { type: SchemaType.STRING },
					description: 'Future topics this lecture sets up',
				},
				related: {
					type: SchemaType.ARRAY,
					items: { type: SchemaType.STRING },
					description: 'Other subjects/areas where this material shows up',
				},
			},
		},
		selfCheck: {
			type: SchemaType.ARRAY,
			description: '3-5 active-recall questions to test understanding',
			items: {
				type: SchemaType.OBJECT,
				properties: {
					question: { type: SchemaType.STRING, description: 'The recall prompt' },
					answer: { type: SchemaType.STRING, description: 'Short reference answer based strictly on the transcript' },
				},
				required: ['question', 'answer'] as string[],
			},
		},
	},
	required: [
		'tldr',
		'summary',
		'keyConcepts',
		'chapters',
		'deepDive',
		'examHints',
		'actionItems',
		'selfCheck',
	] as string[],
}
const SYSTEM_PROMPT = `You are a university lecture note assistant. Given a transcript of a lecture, produce structured study notes optimized for both quick review and active recall.

Rules:
- TLDR: 2-3 sentences. The single most important takeaway from the lecture. No filler like "this lecture covers...".
- Summary: 2-3 paragraphs covering main topics, key takeaways, and how they connect.
- Key Concepts: 5-8 named terms/concepts. Each gets a one-line definition and why it matters. Pick concepts the lecturer named explicitly or returned to repeatedly.
- Chapters: logical sections with timestamps from the transcript segments. Each chapter gets a one-line takeaway so the reader doesn't have to rewatch.
- Deep Dive: topic-by-topic breakdown (not bound to timestamps). For each major topic, explain what it is, how it works (mechanism/steps/pseudocode), why it matters, and include a worked example if the lecturer gave one. Skip the 'example' field if none was given.
- Formulas: any formula, theorem, or precise definition worth putting on a cheat sheet. Use plain text that renders cleanly as LaTeX (e.g. T(n) = aT(n/b) + f(n)).
- Pitfalls: counterintuitive points, common mistakes, or things the lecturer explicitly warned about. Omit if the lecturer didn't flag any.
- Exam Hints: concepts the lecturer emphasized, repeated, or explicitly marked as exam-relevant. Tag each as:
  - "likely" — lecturer basically said this will be on the exam
  - "tricky" — easy to mess up, common wrong answer, edge case
  - "general" — important but not explicitly flagged
- Action Items: homework, readings, deadlines, or tasks the lecturer assigned or suggested.
- Connections: links to other material. "buildsOn" = prerequisites or earlier lectures referenced. "leadsTo" = future topics this sets up. "related" = other subjects this shows up in. Only include items the transcript actually mentions or strongly implies. Leave arrays empty if nothing fits.
- Self-Check: 3-5 active-recall questions with short reference answers grounded strictly in the transcript.

Be precise and factual. Do not hallucinate content not in the transcript. If a section has no relevant content, return an empty array (or omit optional string fields) rather than inventing material.`

/** When Gemma rejects `responseSchema`, retry once with plain JSON MIME + explicit shape (`PostprocessOutputSchema`). */
const JSON_ONLY_SHAPE_TAIL = `\n\nCRITICAL RESPONSE FORMAT:
Return ONLY a single JSON object (no markdown code fences, no commentary) with keys:
- tldr (string),
- summary (string),
- keyConcepts (array of { term, definition, whyItMatters? }),
- chapters (array of { start, end, title, takeaway }),
- deepDive (array of { topic, whatItIs, howItWorks, whyItMatters?, example? }),
- formulas (array of { name, expression, notes? }),
- pitfalls (array of strings),
- examHints (array of { hint, priority: "likely"|"tricky"|"general" }),
- actionItems (array of strings),
- connections ({ buildsOn?, leadsTo?, related?: arrays of strings }),
- selfCheck (array of { question, answer }).
Follow every content rule above; use empty arrays only when the transcript truly has nothing qualifying.`

const STRICT_MIN_FIELDS_NOTE =
  `\n\nCRITICAL: You MUST include non-empty values for tldr, summary, chapters, examHints, actionItems, deepDive, selfCheck, and keyConcepts. Do not return empty arrays for required sections unless the transcript truly lacks all material for that section.`

/** Gemini Flash first; then Gemini 2.5; last `gemma-4-31b-it` on 429/quota or transient overload (`postprocess` loop). Gemma retries without schema when structured output fails. */
const MODELS = ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemma-4-31b-it'] as const

export interface PostprocessOptions {
  /** Run before each `generateContent`; throw to abort when over budget */
  beforeGeminiRequest?: () => void
  /** After each completed `generateContent` (counts 1 retry as a second request) */
  onGeminiRequest?: () => void
}

function geminiErrorStatus(e: unknown): number | undefined {
  const err = e as { status?: number; statusCode?: number }
  if (typeof err?.status === 'number') return err.status
  if (typeof err?.statusCode === 'number') return err.statusCode
  const m = String((e as Error)?.message ?? e).match(/\[\s*(\d{3})\s+/)
  return m ? Number(m[1]) : undefined
}

/** Try the next model in `MODELS` when the current one is rate-limited or temporarily unavailable. */
function shouldFallbackToNextGeminiModel(e: unknown): boolean {
  if (isQuotaError(e)) return false
  const status = geminiErrorStatus(e)
  const msg = String((e as Error)?.message ?? e).toLowerCase()
  if (status === 429 || msg.includes('429') || msg.includes('quota') || msg.includes('rate limit'))
    return true
  if (status === 503 || status === 502 || status === 500 || status === 504)
    return true
  if (
    msg.includes('503')
    || msg.includes('502')
    || msg.includes('500')
    || msg.includes('504')
    || msg.includes('service unavailable')
    || msg.includes('high demand')
    || msg.includes('overloaded')
    || msg.includes('temporarily unavailable')
  )
    return true
  return false
}

export async function postprocess(transcript: string, opts?: PostprocessOptions): Promise<PostprocessOutput> {
  for (const modelName of MODELS) {
    try {
      const result = await callPostprocessModel(modelName, transcript, opts)
      return result
    } catch (e: unknown) {
      if (isQuotaError(e)) throw e
      if (!shouldFallbackToNextGeminiModel(e))
        throw e

      const status = geminiErrorStatus(e)
      const reason = status === 429 || String((e as Error)?.message ?? '').includes('429')
        ? '429/quota'
        : 'transient overload'

      if (modelName === MODELS[MODELS.length - 1]) {
        if (reason === '429/quota')
          throw new QuotaError('gemini', 'all models exhausted', 'utc_midnight')
        throw e
      }

      console.log(`[postprocess] ${reason} on ${modelName}, falling back to next model...`)
      continue
    }
  }

  throw new Error('Unreachable')
}

function stripJsonFence(text: string): string {
  const t = text.trim()
  const m = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(t)
  return (m?.[1] ?? t).trim()
}

function formatModelError(e: unknown): string {
  const err = e as { message?: string; status?: number }
  const base = err?.message ?? String(e)
  return err?.status != null ? `${err.status} ${base}` : base
}

/** True when we can try JSON-only (e.g. Gemma) instead of `responseSchema`. Never true for 429 — outer loop handles that. */
function recoverableStructuredOutputFailure(e: unknown): boolean {
  if (isQuotaError(e)) return false
  const status = (e as { status?: number })?.status
  const msg = String((e as Error)?.message ?? e)
  if (status === 429) return false
  if (status === 400 || status === 404 || status === 503) return true
  if (/schema|structured|mime|unsupported|not supported|invalid argument|invalid model|400/i.test(msg)) return true
  return false
}

async function callPostprocessModel(modelName: string, transcript: string, callbacks?: PostprocessOptions): Promise<PostprocessOutput> {
  if (!modelName.startsWith('gemma-')) {
    return callWithResponseSchema(modelName, transcript, callbacks)
  }
  try {
    return await callWithResponseSchema(modelName, transcript, callbacks)
  } catch (e: unknown) {
    if (!recoverableStructuredOutputFailure(e)) throw e
    console.warn(`[postprocess] ${modelName} structured generation failed (${formatModelError(e)}), retrying JSON-only...`)
    return await callJsonOnlyModel(modelName, transcript, callbacks)
  }
}

async function callWithResponseSchema(modelName: string, transcript: string, callbacks?: PostprocessOptions): Promise<PostprocessOutput> {
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
  const text = stripJsonFence(result.response.text())
  const parsed = JSON.parse(text)

  // Zod validation for defense in depth
  const validated = PostprocessOutputSchema.safeParse(parsed)
  if (!validated.success) {
    console.warn(`[postprocess] Schema validation failed on first attempt, retrying with stricter prompt...`)
    // Retry once with emphasis on required fields
    callbacks?.beforeGeminiRequest?.()
    const retryResult = await model.generateContent(
      SYSTEM_PROMPT +
      STRICT_MIN_FIELDS_NOTE +
      '\n\n--- TRANSCRIPT ---\n\n' + transcript,
    )
    callbacks?.onGeminiRequest?.()
    const retryText = stripJsonFence(retryResult.response.text())
    const retryParsed = JSON.parse(retryText)
    const retryValidated = PostprocessOutputSchema.parse(retryParsed)
    return retryValidated
  }

  return validated.data
}

async function callJsonOnlyModel(modelName: string, transcript: string, callbacks?: PostprocessOptions): Promise<PostprocessOutput> {
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
    },
  })

  const block1 = SYSTEM_PROMPT + JSON_ONLY_SHAPE_TAIL + '\n\n--- TRANSCRIPT ---\n\n' + transcript
  console.log(`[postprocess] Calling ${modelName} (JSON-only, no responseSchema)...`)
  callbacks?.beforeGeminiRequest?.()
  let text = stripJsonFence((await model.generateContent(block1)).response.text())
  callbacks?.onGeminiRequest?.()
  let parsed: unknown = JSON.parse(text)

  let validated = PostprocessOutputSchema.safeParse(parsed)
  if (!validated.success) {
    console.warn(`[postprocess] Schema validation failed on JSON-only attempt, retrying with stricter prompt...`)
    const block2 =
      SYSTEM_PROMPT + JSON_ONLY_SHAPE_TAIL + STRICT_MIN_FIELDS_NOTE + '\n\n--- TRANSCRIPT ---\n\n' + transcript
    callbacks?.beforeGeminiRequest?.()
    text = stripJsonFence((await model.generateContent(block2)).response.text())
    callbacks?.onGeminiRequest?.()
    parsed = JSON.parse(text)
    validated = PostprocessOutputSchema.safeParse(parsed)
    if (!validated.success) throw validated.error
  }

  return validated.data
}
