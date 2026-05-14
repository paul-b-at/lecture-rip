import { Client } from '@notionhq/client'
import type { Lecture, PostprocessOutput, Stage, Subject } from './types'

/** Notion **property names** must match your database schema (case‑sensitive). Override when your columns use different titles. */
const LP = {
  name: nv('NOTION_LECTURES_NAME', 'Name'),
  lectureId: nv('NOTION_LECTURES_LECTURE_ID', 'Lecture ID'),
  courseId: nv('NOTION_LECTURES_COURSE_SUBJECT', 'Course ID'),
  watchUrl: nv('NOTION_LECTURES_MEDIA_URL', 'Moodle URL'),
  status: nv('NOTION_LECTURES_STATUS', 'Status'),
  skipReason: nv('NOTION_LECTURES_SKIP_REASON', 'Skip Reason'),
} as const

const SP = {
  mediaCourseId: nv('NOTION_SUBJECTS_MEDIA_COURSE_ID', 'Media Course ID'),
  mediaSeriesId: nv('NOTION_SUBJECTS_MEDIA_SERIES_ID', 'Media Series ID'),
  glossary: nv('NOTION_SUBJECTS_GLOSSARY', 'Glossary'),
} as const

function nv(key: string, fallback: string): string {
  const v = (typeof process !== 'undefined' ? process.env[key] : '')?.trim()
  return v || fallback
}

/** `NOTION_LECTURES_COURSE_SUBJECT` maps to Subject row id; column may be `rich_text` (UUID string) or a `relation` to Subjects. */
function lectureSubjectColumnKind(): 'relation' | 'rich_text' {
  const raw = nv('NOTION_LECTURES_SUBJECT_KIND', 'rich_text').toLowerCase()
  return raw === 'relation' ? 'relation' : 'rich_text'
}

const notion = new Client({ auth: process.env.NOTION_TOKEN })
const LECTURES_DB = process.env.LECTURES_DS_ID!
const SUBJECTS_DB = process.env.SUBJECTS_DS_ID!

type LectureDbProp = { type: string }

let lecturesDbPropertiesCache: Record<string, LectureDbProp> | null = null

/** Retrieve and cache Lectures DB property schema (name → `{ type }`). */
export async function getLecturesDatabaseProperties(): Promise<Record<string, LectureDbProp>> {
  if (lecturesDbPropertiesCache) return lecturesDbPropertiesCache
  const db = await notion.databases.retrieve({ database_id: LECTURES_DB })
  lecturesDbPropertiesCache = db.properties as Record<string, LectureDbProp>
  return lecturesDbPropertiesCache
}

/**
 * Fail fast with actionable errors when `NOTION_LECTURES_*` names/types do not match the Notion database.
 * Lists every column title and type so you can copy exact spellings into `.env`.
 */
export async function validateLecturesDatabaseConfig(): Promise<void> {
  const props = await getLecturesDatabaseProperties()
  const problems: string[] = []
  const kind = lectureSubjectColumnKind()

  const check = (columnTitle: string, want: string, envKey: string) => {
    const p = props[columnTitle]
    if (!p) {
      problems.push(`No «${columnTitle}» column (want ${want}). Set ${envKey}=… to match your DB **exact title** (case-sensitive).`)
      return
    }
    if (p.type !== want)
      problems.push(`«${columnTitle}» exists but Notion type is «${p.type}», expected «${want}». Rename the column or point ${envKey} at a ${want} column.`)
  }

  check(LP.name, 'title', 'NOTION_LECTURES_NAME')
  check(LP.lectureId, 'rich_text', 'NOTION_LECTURES_LECTURE_ID')
  check(LP.courseId, kind, 'NOTION_LECTURES_COURSE_SUBJECT')
  check(LP.watchUrl, 'url', 'NOTION_LECTURES_MEDIA_URL')
  check(LP.status, 'select', 'NOTION_LECTURES_STATUS')
  check(LP.skipReason, 'rich_text', 'NOTION_LECTURES_SKIP_REASON')

  const statusProp = props[LP.status] as { type?: string; select?: { options?: Array<{ name: string }> } } | undefined
  if (statusProp?.type === 'select') {
    const names =
      statusProp.select?.options?.map(o => o.name).filter((n): n is string => Boolean(n?.trim()))
      ?? []
    if (names.length > 0 && !names.includes('Discovered')) {
      problems.push(
        `Status column «${LP.status}» has no «Discovered» option. Existing options: ${names.join(', ')}.`,
      )
    }
  }

  if (problems.length === 0) return

  const listing = Object.keys(props)
    .sort()
    .map(k => `  • "${k}" → ${props[k]!.type}`)
    .join('\n')

  throw new Error(
    `${problems.join('\n')}\n\nActual columns on the Lectures database:\n${listing}\n\nFix: copy each column title above into NOTION_LECTURES_* vars in \`.env\` (see \`.env.example\`).`,
  )
}

export async function fetchSubjects(): Promise<Subject[]> {
  const out: Subject[] = []
  let cursor: string | undefined

  do {
    const response: any = await notion.databases.query({
      database_id: SUBJECTS_DB,
      start_cursor: cursor,
    })

    for (const page of response.results) {
      out.push({
        id: page.id,
        notionPageId: page.id,
        name: getTitle(page),
        mediaCourseId:
          getRichText(page, SP.mediaCourseId)
          || getFormulaString(page, SP.mediaCourseId),
        mediaSeriesId:
          getRichText(page, SP.mediaSeriesId)
          || getUrl(page, SP.mediaSeriesId)
          || extractFormulaUuid(page, SP.mediaSeriesId),
        glossary: getRichText(page, SP.glossary),
      })
    }

    cursor = response.has_more ? response.next_cursor : undefined
  } while (cursor)

  return out
}

export async function fetchExistingLectures(): Promise<Map<string, Lecture>> {
  const map = new Map<string, Lecture>()
  let cursor: string | undefined

  do {
    const response: any = await notion.databases.query({
      database_id: LECTURES_DB,
      start_cursor: cursor,
    })

    for (const page of response.results) {
      const lectureId = getRichText(page, LP.lectureId)
      if (!lectureId) continue

      const sid =
        lectureSubjectColumnKind() === 'relation'
          ? firstRelationTargetId(page, LP.courseId)
          : getRichText(page, LP.courseId)

      map.set(lectureId, {
        id: lectureId,
        notionPageId: page.id,
        title: getTitle(page),
        courseId: sid,
        moodleUrl: getUrl(page, LP.watchUrl) || getRichText(page, LP.watchUrl),
        status: getSelect(page, LP.status) as Stage ?? 'Discovered',
        skipReason: getRichText(page, LP.skipReason),
      })
    }

    cursor = response.has_more ? response.next_cursor : undefined
  } while (cursor)

  return map
}

export async function upsertLecture(
  lecture: { id: string; title: string; courseId: string; moodleUrl: string },
  existingPageId?: string,
): Promise<string> {
  if (existingPageId) return existingPageId

  const subjectProp =
    lectureSubjectColumnKind() === 'relation'
      ? ({
          [LP.courseId]: lecture.courseId
            ? { relation: [{ id: lecture.courseId }] }
            : { relation: [] },
        } satisfies Record<string, unknown>)
      : ({
          [LP.courseId]: { rich_text: [{ text: { content: lecture.courseId } }] },
        } satisfies Record<string, unknown>)

  const response = await notion.pages.create({
    parent: { database_id: LECTURES_DB },
    properties: {
      [LP.name]: { title: [{ text: { content: lecture.title } }] },
      [LP.lectureId]: { rich_text: [{ text: { content: lecture.id } }] },
      ...subjectProp,
      [LP.watchUrl]: { url: lecture.moodleUrl },
      [LP.status]: { select: { name: 'Discovered' } },
    },
  })

  return response.id
}

export async function setStage(pageId: string, stage: Stage): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      [LP.status]: { select: { name: stage } },
    },
  })
}

export async function setSkipReason(pageId: string, reason: string): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      [LP.skipReason]: { rich_text: [{ text: { content: reason } }] },
    },
  })
}

export async function writePostprocessResults(pageId: string, output: PostprocessOutput): Promise<void> {
  const chaptersText = output.chapters
    .map(c => `${c.start}–${c.end}: ${c.title}`)
    .join('\n')

  const examText = output.examHints.join('\n• ')
  const actionText = output.actionItems.join('\n• ')

  await notion.blocks.children.append({
    block_id: pageId,
    children: [
      {
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: 'Summary' } }] },
      },
      {
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: richTextRunsFromString(output.summary) },
      },
      {
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ type: 'text', text: { content: 'Chapters' } }] },
      },
      {
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: richTextRunsFromString(chaptersText) },
      },
      ...(output.examHints.length > 0 ? [
        {
          object: 'block' as const,
          type: 'heading_2' as const,
          heading_2: { rich_text: [{ type: 'text' as const, text: { content: 'Exam Hints' } }] },
        },
        {
          object: 'block' as const,
          type: 'paragraph' as const,
          paragraph: { rich_text: richTextRunsFromString('• ' + examText) },
        },
      ] : []),
      ...(output.actionItems.length > 0 ? [
        {
          object: 'block' as const,
          type: 'heading_2' as const,
          heading_2: { rich_text: [{ type: 'text' as const, text: { content: 'Action Items' } }] },
        },
        {
          object: 'block' as const,
          type: 'paragraph' as const,
          paragraph: { rich_text: richTextRunsFromString('• ' + actionText) },
        },
      ] : []),
    ],
  })
}

// --- Helpers ---

function getTitle(page: any): string {
  const prop = Object.values(page.properties).find((p: any) => p.type === 'title') as any
  return prop?.title?.[0]?.plain_text ?? ''
}

function getRichText(page: any, propName: string): string {
  const prop = page.properties[propName]
  if (!prop || prop.type !== 'rich_text') return ''
  return prop.rich_text?.[0]?.plain_text ?? ''
}

function firstRelationTargetId(page: any, propName: string): string {
  const prop = page.properties[propName]
  if (!prop || prop.type !== 'relation') return ''
  const r = prop.relation
  const id = Array.isArray(r) && r.length > 0 && typeof r[0]?.id === 'string' ? r[0].id : ''
  return id ?? ''
}

function getUrl(page: any, propName: string): string {
  const prop = page.properties[propName]
  if (!prop || prop.type !== 'url') return ''
  return prop.url ?? ''
}

function extractFormulaUuid(page: any, propName: string): string {
  const prop = page.properties[propName]
  if (!prop || prop.type !== 'formula') return ''
  const f = prop.formula as { type?: string; string?: string } | undefined
  const s = (f?.type === 'string' ? (f.string ?? '').trim() : '').trim()
  const m = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  return m?.[0] ?? ''
}

/** Formula columns sometimes hold plain text like LU digits. */
function getFormulaString(page: any, propName: string): string {
  const prop = page.properties[propName]
  if (!prop || prop.type !== 'formula') return ''
  const f = prop.formula
  if (!f) return ''
  if (f.type === 'string') return f.string ?? ''
  if (f.type === 'number') return f.number != null ? String(f.number) : ''
  return ''
}

function getSelect(page: any, propName: string): string {
  const prop = page.properties[propName]
  if (!prop || prop.type !== 'select') return ''
  return prop.select?.name ?? ''
}

/** Notion caps each `rich_text[].text.content` at 2000 chars; split into inline runs. */
const NOTION_RICH_TEXT_CONTENT_MAX = 2000

function richTextRunsFromString(s: string): Array<{ type: 'text'; text: { content: string } }> {
  const t = s.length > 0 ? s : '—'
  const runs: Array<{ type: 'text'; text: { content: string } }> = []
  for (let i = 0; i < t.length; i += NOTION_RICH_TEXT_CONTENT_MAX) {
    runs.push({ type: 'text', text: { content: t.slice(i, i + NOTION_RICH_TEXT_CONTENT_MAX) } })
  }
  return runs
}
