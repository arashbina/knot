import path from 'node:path'
import matter from 'gray-matter'
import {
  STATUS_ALIASES, TASK_STATUSES, TODO_MARKERS,
  type Author, type Task, type TaskStatus, type TaskUpdate, type TodoItem, type TodoState,
} from './types.js'

const TODO_SECTION = /^##\s+todo\s*$/i
const UPDATES_SECTION = /^##\s+updates\s*$/i
/** A `##` heading at column 0: a section break unless it is fenced. */
export const SECTION_HEADING = /^##\s+/
const CHECKBOX = /^(\s*)[-*]\s+\[(.)\]\s+(.*)$/
// Writes use an em dash; hyphens are accepted so a hand-typed heading still parses.
export const UPDATE_HEADING = /^###\s+(\S+(?:\s+\S+)?)\s+(?:—|–|--?)\s+(human|agent)\s*$/

const TAB_WIDTH = 4

export function splitLines(raw: string): string[] {
  return raw.split(/\r?\n/)
}

/** One line of an error, for a message that must stay on one line. */
export function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0]
}

/** Visual width of leading whitespace; a tab advances to the next multiple of 4. */
export function indentWidth(line: string): number {
  let width = 0
  for (const ch of line) {
    if (ch === ' ') width++
    else if (ch === '\t') width += TAB_WIDTH - (width % TAB_WIDTH)
    else break
  }
  return width
}

function expandLeadingTabs(line: string): string {
  const lead = /^\s*/.exec(line)![0]
  return ' '.repeat(indentWidth(lead)) + line.slice(lead.length)
}

function opensFrontmatter(lines: string[]): boolean {
  return lines[0]?.replace(/^\uFEFF/, '').trimEnd() === '---'
}

/** Line index of the closing `---`, or -1 when there is no (terminated) frontmatter. */
export function frontmatterEnd(lines: string[]): number {
  if (!opensFrontmatter(lines)) return -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trimEnd() === '---') return i
  }
  return -1
}

/** The line after the closing `---`, or 0 when there is no frontmatter. */
export function bodyOffset(lines: string[]): number {
  return frontmatterEnd(lines) + 1
}

interface FenceRun { char: string; len: number; opens: boolean; closes: boolean }

function fenceRun(line: string): FenceRun | undefined {
  const m = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line)
  if (!m || indentWidth(m[1]) > 3) return undefined
  const char = m[2][0]
  return { char, len: m[2].length, opens: char === '~' || !m[3].includes('`'), closes: /^[ \t]*$/.test(m[3]) }
}

/**
 * Which lines, from `from` on, belong to a closed code fence, delimiters included.
 * CommonMark's rules, except that one stray ``` must not swallow the sections after it:
 * - an opener nothing closes is no fence (CommonMark runs it to EOF);
 * - no fence spans an update heading, so each update is a block of its own. Otherwise a
 *   stray opener above pairs with the closer of a code block in an update, and hides every
 *   `##` and update heading in between.
 */
export function fencedLines(lines: string[], from = 0): boolean[] {
  const runs = lines.map((line, i) => (i < from ? undefined : fenceRun(line)))
  // The longest closer from each line up to the next update heading, per character: an
  // unclosed opener is skipped without a scan, which would make the pass quadratic.
  const reach: Record<string, number[]> = { '`': Array(lines.length + 1).fill(0), '~': Array(lines.length + 1).fill(0) }
  for (let i = lines.length - 1; i >= from; i--) {
    const barrier = UPDATE_HEADING.test(lines[i])
    reach['`'][i] = barrier ? 0 : reach['`'][i + 1]
    reach['~'][i] = barrier ? 0 : reach['~'][i + 1]
    const r = runs[i]
    if (r?.closes) reach[r.char][i] = Math.max(reach[r.char][i], r.len)
  }
  const fenced = lines.map(() => false)
  for (let i = from; i < lines.length; i++) {
    const open = runs[i]
    if (!open?.opens || reach[open.char][i + 1] < open.len) continue
    let j = i + 1
    while (!(runs[j]?.closes && runs[j]!.char === open.char && runs[j]!.len >= open.len)) j++
    fenced.fill(true, i, j + 1)
    i = j
  }
  return fenced
}

export type SectionKind = 'body' | 'todo' | 'updates'

export interface Section {
  kind: SectionKind
  /** Line of the `##` heading, or -1 for the region before the first heading. */
  head: number
  /** Exclusive end: the next `##` heading or EOF. */
  end: number
}

/** Splits everything after the frontmatter into sections at column-0 `##` headings outside code fences. */
export function scanSections(lines: string[], fenced = fencedLines(lines, bodyOffset(lines))): Section[] {
  const sections: Section[] = []
  let current: Section = { kind: 'body', head: -1, end: lines.length }
  for (let i = bodyOffset(lines); i < lines.length; i++) {
    if (fenced[i] || !SECTION_HEADING.test(lines[i])) continue
    current.end = i
    sections.push(current)
    const kind: SectionKind = TODO_SECTION.test(lines[i]) ? 'todo'
      : UPDATES_SECTION.test(lines[i]) ? 'updates' : 'body'
    current = { kind, head: i, end: lines.length }
  }
  sections.push(current)
  return sections
}

function readDetail(lines: string[], start: number, indent: number): { endLine: number; detail: string } {
  let endLine = start + 1
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j]
    if (SECTION_HEADING.test(line)) break
    if (line.trim() === '') continue
    if (indentWidth(line) <= indent) break
    endLine = j + 1
  }
  const block = lines.slice(start + 1, endLine).map(expandLeadingTabs)
  const widths = block.filter((l) => l.trim() !== '').map(indentWidth)
  const cut = widths.length ? Math.min(...widths) : 0
  const detail = block
    .map((l) => (l.trim() === '' ? '' : l.slice(cut).trimEnd()))
    .join('\n')
    .replace(/^\n+/, '')
    .trimEnd()
  return { endLine, detail }
}

function exactStatus(value: string): TaskStatus | undefined {
  const v = value.trim().toLowerCase()
  return (TASK_STATUSES as readonly string[]).includes(v) ? (v as TaskStatus) : STATUS_ALIASES[v]
}

/** A status name, an alias (`wip`), or an unambiguous prefix of either (`rev`, `bl`). */
export function parseStatus(input: string): TaskStatus | undefined {
  const exact = exactStatus(input)
  if (exact) return exact
  const q = input.trim().toLowerCase()
  if (!q) return undefined
  const names: [string, TaskStatus][] = [...TASK_STATUSES.map((s) => [s, s] as [string, TaskStatus]), ...Object.entries(STATUS_ALIASES)]
  const matches = new Set(names.filter(([name]) => name.startsWith(q)).map(([, status]) => status))
  return matches.size === 1 ? [...matches][0] : undefined
}

/** Anything unrecognised — including the retired `todo` — reads as backlog. */
function coerceStatus(value: unknown): TaskStatus {
  return (typeof value === 'string' && exactStatus(value)) || 'backlog'
}

function coerceTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((t) => t !== '')
  if (typeof value === 'string') return value.split(',').map((t) => t.trim()).filter((t) => t !== '')
  return []
}

/** js-yaml turns an unquoted timestamp — or a title that looks like one — into a Date. */
function coerceText(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '')
}

/** The state a checkbox marker stands for; an unknown marker reads as pending. */
export function todoState(marker: string): TodoState {
  return Object.hasOwn(TODO_MARKERS, marker)
    ? TODO_MARKERS[marker as keyof typeof TODO_MARKERS]
    : 'pending'
}

/** Checkbox items between `from` and `end`; a deeper checkbox is detail, not a sibling. */
function readTodos(lines: string[], from: number, end: number, fenced: boolean[], into: TodoItem[]): void {
  for (let i = from; i < end; i++) {
    const m = fenced[i] ? null : CHECKBOX.exec(lines[i])
    if (!m) continue
    const indent = indentWidth(m[1])
    const { endLine, detail } = readDetail(lines, i, indent)
    into.push({ ordinal: into.length + 1, line: i, endLine, text: m[3].trimEnd(), state: todoState(m[2]), indent, detail })
    i = endLine - 1
  }
}

function readUpdates(lines: string[], from: number, end: number, fenced: boolean[], into: TaskUpdate[]): void {
  let pending: { at: string; author: Author; lines: string[] } | undefined
  const flush = () => {
    if (pending) into.push({ at: pending.at, author: pending.author, body: pending.lines.join('\n').trim() })
  }
  for (let i = from; i < end; i++) {
    const line = lines[i]
    const u = fenced[i] ? null : UPDATE_HEADING.exec(line)
    if (u) {
      flush()
      pending = { at: u[1], author: u[2] as Author, lines: [] }
    } else if (pending) {
      pending.lines.push(line)
    } else if (line.trim()) {
      // A note typed by hand under `## Updates` with no heading. The CLI always writes
      // one, so this came from a person; keep it rather than dropping it unseen.
      pending = { at: '', author: 'human', lines: [line] }
    }
  }
  flush()
}

function refuseEngine(): never {
  throw new Error('only YAML frontmatter is supported')
}

/** Never throws: broken YAML yields a task with `error` set and an id from the filename. */
export function parseTask(file: string, raw: string): Task {
  const lines = splitLines(raw)
  let data: Record<string, unknown> = {}
  let error: string | undefined
  if (opensFrontmatter(lines)) {
    if (frontmatterEnd(lines) < 0) error = 'unterminated frontmatter'
    else {
      // gray-matter takes its engine from the text after the opening `---`, and `---js`
      // would eval() the block. Only a bare `---` gets here, which means YAML; refusing
      // the JavaScript engine as well keeps that true if the guard above ever loosens.
      // The options arg also bypasses gray-matter's cache, which stores the input *before*
      // parsing — a broken file would otherwise throw once, then parse as `{}` forever.
      try { data = matter(raw, { engines: { javascript: refuseEngine } }).data as Record<string, unknown> }
      catch (e) { error = firstLine(e) }
    }
  } else {
    // `---js`, `---yaml`: never read, but a task whose id, title and status quietly fall
    // back to the filename needs to say why. `----` is a rule, not an opener.
    const opener = /^---(?!-)[ \t]*\S.*/.exec(lines[0]?.replace(/^\uFEFF/, '') ?? '')
    if (opener) error = `frontmatter must open with a bare --- (YAML only), not ${JSON.stringify(opener[0].trimEnd())}`
  }

  const base = path.basename(file, '.md')
  const body: string[] = []
  const todos: TodoItem[] = []
  const updates: TaskUpdate[] = []
  const start = bodyOffset(lines)
  const fenced = fencedLines(lines, start)
  for (const s of scanSections(lines, fenced)) {
    if (s.kind === 'body') body.push(...lines.slice(s.head < 0 ? start : s.head, s.end))
    else if (s.kind === 'todo') readTodos(lines, s.head + 1, s.end, fenced, todos)
    else readUpdates(lines, s.head + 1, s.end, fenced, updates)
  }

  const created = coerceText(data.created)
  const task: Task = {
    id: coerceText(data.id).trim() || base,
    title: coerceText(data.title).trim() || base,
    status: coerceStatus(data.status),
    tags: coerceTags(data.tags),
    created,
    updated: data.updated == null ? created : coerceText(data.updated),
    body: body.join('\n').trim(),
    todos,
    updates,
    file,
  }
  const dir = coerceText(data.dir).trim()
  if (dir) task.dir = dir
  if (error) task.error = error
  return task
}
