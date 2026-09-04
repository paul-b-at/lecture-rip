import { mkdir } from 'node:fs/promises'
import { z } from 'zod'
import type { AnkiCard } from './types'

const CARDS_PATH = 'out/cards.json'

export interface LectureCardBatch {
  lectureId: string
  courseSlug: string
  lectureDate: string
  cards: AnkiCard[]
}

const AnkiCardSchema = z.object({
  type: z.enum(['mc', 'basic', 'cloze']),
  front: z.string().min(1),
  options: z.array(z.string()).optional(),
  correct: z.number().optional(),
  back: z.string().min(1),
  tags: z.array(z.string()),
})

const CLOZE_RE = /\{\{c\d+::.+?\}\}/

function isValidMc(card: z.infer<typeof AnkiCardSchema>): boolean {
  if (!Array.isArray(card.options) || card.options.length !== 4)
    return false
  if (!card.options.every(o => typeof o === 'string' && o.trim().length > 0))
    return false
  if (typeof card.correct !== 'number' || !Number.isInteger(card.correct))
    return false
  return card.correct >= 0 && card.correct <= 3
}

function isValidCloze(card: z.infer<typeof AnkiCardSchema>): boolean {
  return CLOZE_RE.test(card.front)
}

/** Drop invalid cards; log count. Never throws. */
export function validateAnkiCards(raw: unknown): { cards: AnkiCard[]; dropped: number } {
  if (!Array.isArray(raw))
    return { cards: [], dropped: 0 }

  let dropped = 0
  const cards: AnkiCard[] = []

  for (const item of raw) {
    const parsed = AnkiCardSchema.safeParse(item)
    if (!parsed.success) {
      dropped++
      continue
    }
    const card = parsed.data
    if (card.type === 'mc' && !isValidMc(card)) {
      dropped++
      continue
    }
    if (card.type === 'cloze' && !isValidCloze(card)) {
      dropped++
      continue
    }
    cards.push({
      type: card.type,
      front: card.front.trim(),
      back: card.back.trim(),
      tags: card.tags.map(t => t.trim()).filter(Boolean),
      ...(card.type === 'mc'
        ? { options: card.options!.map(o => o.trim()), correct: card.correct }
        : {}),
    })
  }

  if (dropped > 0)
    console.warn(`[cards] Dropped ${dropped} invalid Anki card(s)`)

  return { cards, dropped }
}

/** Slug for deck name `JKU::{courseSlug}`. */
export function slugifyCourseName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'unknown'
}

const DATE_PATTERNS: Array<{ re: RegExp; parse: (m: RegExpMatchArray) => string | null }> = [
  {
    re: /\b(20\d{2})-(\d{2})-(\d{2})\b/,
    parse: m => `${m[1]}-${m[2]}-${m[3]}`,
  },
  {
    re: /\b(\d{2})\.(\d{2})\.(20\d{2})\b/,
    parse: m => `${m[3]}-${m[2]}-${m[1]}`,
  },
  {
    re: /\b(20\d{2})(\d{2})(\d{2})\b/,
    parse: m => `${m[1]}-${m[2]}-${m[3]}`,
  },
]

/** Best-effort YYYY-MM-DD from lecture title; falls back to UTC today. */
export function extractLectureDate(title: string): string {
  for (const { re, parse } of DATE_PATTERNS) {
    const m = title.match(re)
    if (m) {
      const d = parse(m)
      if (d && isValidIsoDate(d))
        return d
    }
  }
  return new Date().toISOString().slice(0, 10)
}

function isValidIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m)
    return false
  const d = new Date(`${s}T12:00:00Z`)
  return !Number.isNaN(d.getTime())
    && d.getUTCFullYear() === Number(m[1])
    && d.getUTCMonth() + 1 === Number(m[2])
    && d.getUTCDate() === Number(m[3])
}

async function readExistingBatches(): Promise<LectureCardBatch[]> {
  const file = Bun.file(CARDS_PATH)
  if (!(await file.exists()))
    return []
  try {
    const raw = await file.json()
    return Array.isArray(raw) ? raw as LectureCardBatch[] : []
  }
  catch {
    return []
  }
}

/** Append one lecture batch to out/cards.json (dedupes by lectureId). Never throws. */
export async function appendLectureCards(batch: LectureCardBatch): Promise<void> {
  if (batch.cards.length === 0) {
    console.log(`[cards] No valid cards for ${batch.lectureId} — skipping write`)
    return
  }

  try {
    const existing = await readExistingBatches()
    const filtered = existing.filter(b => b.lectureId !== batch.lectureId)
    filtered.push(batch)
    await mkdir('out', { recursive: true })
    await Bun.write(CARDS_PATH, JSON.stringify(filtered, null, 2))
    console.log(`[cards] Wrote ${batch.cards.length} card(s) for ${batch.lectureId} → ${CARDS_PATH}`)
  }
  catch (e) {
    console.warn(`[cards] Failed to write ${CARDS_PATH}:`, e)
  }
}
