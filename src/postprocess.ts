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
