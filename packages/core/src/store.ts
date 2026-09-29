import fs from 'node:fs'
import path from 'node:path'
import { dropClaim } from './claim.js'
import { SECTION_HEADING, UPDATE_HEADING, bodyOffset, fencedLines, frontmatterEnd, parseTask, scanSections, splitLines } from './parse.js'
import {
  DETAIL_INDENT, MARKER_FOR_STATE, TASK_STATUSES,
  type Author, type CreateTaskInput, type Task, type TaskStatus, type TodoItem, type TodoState,
} from './types.js'

export interface Store { dir: string }

/** A missing task, todo or vault. The CLI maps it (and any core error) to exit 2. */
export class NotFoundError extends Error {}

/**
 * Creating the vault is opt-in: pointing KNOT_DIR at a typo must fail loudly,
 * so only creation paths (`knot new`, the TUI's first launch on the default vault) pass `create: true`.
 */
export function openStore(dir: string, opts: { create?: boolean } = {}): Store {
  const abs = path.resolve(dir)
  if (!fs.existsSync(abs)) {
    if (!opts.create) throw new NotFoundError(`vault not found: ${abs}`)
    fs.mkdirSync(abs, { recursive: true })
  } else if (!fs.statSync(abs).isDirectory()) throw new NotFoundError(`vault is not a directory: ${abs}`)
  return { dir: abs }
}

function listFiles(store: Store): string[] {
  return fs.readdirSync(store.dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
    .map((name) => path.join(store.dir, name))
}

export function loadAll(store: Store): Task[] {
  const tasks: Task[] = []
  for (const file of listFiles(store)) {
    let raw: string
    try { raw = fs.readFileSync(file, 'utf8') }
    catch { continue } // vanished between readdir and read
    tasks.push(parseTask(file, raw))
  }
  return tasks
}

/** By frontmatter id, falling back to the filename so broken-frontmatter files stay addressable. */
export function findTask(tasks: Task[], id: string): Task | undefined {
  return tasks.find((t) => t.id === id)
    ?? tasks.find((t) => {
      const base = path.basename(t.file, '.md')
      return base === id || base.startsWith(`${id}-`)
    })
}

export function load(store: Store, id: string): Task | undefined {
  return findTask(loadAll(store), id)
}

const YAML_RESERVED = /^(true|false|yes|no|on|off|null|~)$/i
// YAML 1.1 implicit types gray-matter's js-yaml would coerce: hex/octal/binary, sexagesimal, .inf/.nan, timestamps.
const YAML_IMPLICIT = /^[-+]?(?:0x[\da-f_]+|0o?[0-7_]+|0b[01_]+|[\d_]+(?::[0-5]?\d)+(?:\.\d*)?|\.(?:inf|nan))$|^\d{4}-\d\d?-\d\d?/i

/** Guards everything entering frontmatter. Always returns a single line. */
export function yamlScalar(input: string): string {
  const value = input.replace(/\s*[\r\n]+\s*/g, ' ')
  const needsQuote =
    value === '' ||
    value !== value.trim() ||
    /:(\s|$)/.test(value) ||
    /\s#/.test(value) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /[[\]{},]/.test(value) ||
    YAML_RESERVED.test(value) ||
    /^[\d.+-]+$/.test(value) ||
    YAML_IMPLICIT.test(value)
  return needsQuote ? `'${value.replace(/'/g, "''")}'` : value
}

function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

function unixNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** A todo's detail as the lines under its checkbox, each prefixed with `lead`. Empty text → no lines. */
function detailBlock(detail: string, lead: string): string[] {
  const text = unixNewlines(detail).replace(/^\n+/, '').trimEnd()
  return text ? text.split('\n').map((l) => (l.trim() === '' ? '' : lead + l)) : []
}

export function normalizeTags(tags: string[]): string[] {
  const out: string[] = []
  for (const raw of tags.flatMap((t) => t.split(/[,\s]+/))) {
    const tag = raw.trim().replace(/^#+/, '')
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replaces `key`, swallowing its continuation lines — Obsidian's Properties editor
 * rewrites `tags: [a, b]` as an indented block list, and replacing only the `tags:`
 * line would orphan the items. `value` is written verbatim; callers pass it through
 * `yamlScalar` themselves.
 */
function setFrontmatter(lines: string[], key: string, value: string): void {
  const entry = `${key}: ${value}`
  const close = frontmatterEnd(lines)
  if (close < 0) {
    lines.unshift('---', entry, '---')
    return
  }
  const at = findKey(lines, close, key)
  if (at) lines.splice(at.start, at.end - at.start, entry)
  else lines.splice(close, 0, entry)
}

/** Removes `key` and its continuation lines; no-op when absent. */
function removeFrontmatter(lines: string[], key: string): void {
  const close = frontmatterEnd(lines)
  const at = close < 0 ? undefined : findKey(lines, close, key)
  if (at) lines.splice(at.start, at.end - at.start)
}

function findKey(lines: string[], close: number, key: string): { start: number; end: number } | undefined {
  const keyRe = new RegExp(`^${escapeRe(key)}\\s*:`)
  for (let i = 1; i < close; i++) {
    if (!keyRe.test(lines[i])) continue
    let j = i + 1
    while (j < close && (/^\s+\S/.test(lines[j]) || /^-(\s|$)/.test(lines[j]))) j++
    return { start: i, end: j }
  }
  return undefined
}

function touch(lines: string[]): void {
  setFrontmatter(lines, 'updated', new Date().toISOString())
}

export function todoLine(task: Task, ordinal: number): TodoItem {
  const item = task.todos.find((t) => t.ordinal === ordinal)
  if (!item) throw new NotFoundError(`no todo #${ordinal} on ${task.id}`)
  return item
}

/** Read-modify-write rounds before giving up on a file that keeps changing underneath. */
const WRITE_ATTEMPTS = 4

/**
 * Read-modify-write against the file as it is *now*. Line numbers come from a fresh
 * parse, never from the caller's (possibly stale) Task, so an external edit between
 * load and write can't redirect the change to the wrong line. A save that lands while
 * the new text is being written sends the whole round back to the read.
 */
function mutate(task: Task, edit: (lines: string[], fresh: Task) => void): Task {
  const name = path.basename(task.file)
  for (let attempt = 1; ; attempt++) {
    const raw = readSettled(task.file)
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    const lines = splitLines(raw)
    const fresh = parseTask(task.file, raw)
    // A read can also land part-way through another program's save; editing that would
    // write the fragment over the task. (A new empty note passes: its id is its basename.)
    if (fresh.id !== task.id) throw new Error(`${name} no longer reads as ${task.id} (mid-save?); not written, try again`)
    if (fresh.error !== undefined && task.error === undefined) throw new Error(`${name}: ${fresh.error} (mid-save?); not written, try again`)
    edit(lines, fresh)
    if (lines.join(eol) === raw) return fresh
    touch(lines)
    const next = lines.join(eol)
    if (writeAtomic(task.file, next, raw)) return parseTask(task.file, next)
    if (attempt === WRITE_ATTEMPTS) throw new Error(`${name} changed while writing; not written, try again`)
  }
}

/**
 * An editor saving in place truncates before it writes, so a read can land in between:
 * an empty file gets ~100ms to fill. One still empty is a new note (Obsidian's Untitled.md).
 */
function readSettled(file: string): string {
  const nap = new Int32Array(new SharedArrayBuffer(4))
  let raw = fs.readFileSync(file, 'utf8')
  for (let i = 0; i < 10 && raw.trim() === ''; i++) {
    Atomics.wait(nap, 0, 0, 10)
    raw = fs.readFileSync(file, 'utf8')
  }
  return raw
}

/**
 * Temp file then rename, so a concurrent reader sees the old file or the new one, never
 * a truncated one. The temp name is a dotfile not ending in .md, which listFiles and the
 * watcher skip. Rename swaps the inode, so the mode is copied over by hand. False, with
 * nothing written, when the file no longer holds `base`, the text the edit was made from:
 * renaming over someone's save would drop it. Between that check and the rename there is
 * still a window, but microseconds, not the whole write.
 */
function writeAtomic(file: string, text: string, base: string): boolean {
  // Rename needs only the folder to be writable: refuse a read-only file as an in-place write would.
  fs.accessSync(file, fs.constants.W_OK)
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  let renamed = false
  try {
    const fd = fs.openSync(tmp, 'w')
    try {
      fs.writeFileSync(fd, text)
      fs.fchmodSync(fd, fs.statSync(file).mode & 0o7777)
    } finally {
      fs.closeSync(fd)
    }
    if (fs.readFileSync(file, 'utf8') === base) {
      fs.renameSync(tmp, file)
      renamed = true
    }
  } finally {
    if (!renamed) fs.rmSync(tmp, { force: true })
  }
  return renamed
}

export function setStatus(task: Task, status: TaskStatus): Task {
  if (!TASK_STATUSES.includes(status)) throw new Error(`invalid status: ${status}`)
  return mutate(task, (lines) => setFrontmatter(lines, 'status', status))
}

export function setTags(task: Task, tags: string[]): Task {
  const value = `[${normalizeTags(tags).map(yamlScalar).join(', ')}]`
  return mutate(task, (lines) => setFrontmatter(lines, 'tags', value))
}

/** The optional project directory; undefined or blank removes it. */
export function setDir(task: Task, dir: string | undefined): Task {
  const value = dir === undefined ? '' : singleLine(dir)
  return mutate(task, (lines) => (value ? setFrontmatter(lines, 'dir', yamlScalar(value)) : removeFrontmatter(lines, 'dir')))
}

export function setTitle(task: Task, title: string): Task {
  const text = singleLine(title)
  if (!text) throw new Error('title is empty')
  return mutate(task, (lines) => setFrontmatter(lines, 'title', yamlScalar(text)))
}

/**
 * Replaces every body region — the prose before the first heading and any `##`
 * section that isn't Todo or Updates — so it round-trips with `Task.body`. The new
 * body lands right after the frontmatter.
 */
export function setBody(task: Task, body: string): Task {
  const text = unixNewlines(body).trim()
  return mutate(task, (lines, fresh) => {
    const sections = scanSections(lines)
    refuseHiddenHeading(task, lines)
    const start = bodyOffset(lines)
    for (const s of sections.reverse()) {
      if (s.kind !== 'body') continue
      const from = s.head < 0 ? start : s.head
      lines.splice(from, s.end - from)
    }
    const block = text ? [...text.split('\n'), ''] : []
    if (start > 0) block.unshift('')
    lines.splice(start, 0, ...block)
    assertReadsAs(task, lines, { body: text, todos: fresh.todos.length, updates: fresh.updates.length })
    refuseHiddenHeading(task, lines)
  })
}

/**
 * A `## Todo`/`## Updates` inside a fence, with no real one of that kind: a stray ``` pairing
 * with one in a todo's detail looks exactly like a closed example, and the body then runs over
 * the hidden section, so replacing it would delete the todos. Checked after the splice too, so
 * setBody never writes a file its next call refuses.
 */
function refuseHiddenHeading(task: Task, lines: string[]): void {
  const sections = scanSections(lines)
  const hidden = scanSections(lines, lines.map(() => false)).find((s) => s.kind !== 'body'
    && !sections.some((v) => v.kind === s.kind)
    && sections.some((v) => v.kind === 'body' && v.head < s.head && s.head < v.end))
  if (!hidden) return
  const heading = lines[hidden.head].trim()
  throw new Error(`${path.basename(task.file)}: a code fence hides its ${heading} heading (line ${hidden.head + 1}); not written — close the fence above it, or add a real ${heading} section`)
}

/**
 * Refuses an edit that changes how the rest of the file parses: an unclosed ``` pairing
 * with a fence further down hides every heading in between, and a `---` can close
 * unterminated frontmatter. What the hidden part held would read as body or update, and
 * a later `knot body` would delete it.
 */
function assertReadsAs(task: Task, lines: string[], want: { body: string; todos: number; updates: number }): void {
  const after = parseTask(task.file, lines.join('\n'))
  if (after.body !== want.body || after.todos.length !== want.todos || after.updates.length !== want.updates)
    throw new Error(`${path.basename(task.file)}: that would change the task's todos, updates or body beyond the edit; not written`)
}

function trimTrailingBlanks(lines: string[]): void {
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
}

export function addTodo(task: Task, text: string): Task {
  const value = singleLine(text)
  if (!value) throw new Error('todo text is empty')
  const item = `- [ ] ${value}`
  return mutate(task, (lines) => {
    const sections = scanSections(lines)
    const todo = sections.find((s) => s.kind === 'todo')
    if (todo) {
      let pos = todo.end
      while (pos > todo.head + 1 && lines[pos - 1].trim() === '') pos--
      const insert = pos === todo.head + 1 ? ['', item] : [item]
      lines.splice(pos, 0, ...insert)
      const after = pos + insert.length
      if (after < lines.length && lines[after].trim() !== '') lines.splice(after, 0, '')
      return
    }
    const updates = sections.find((s) => s.kind === 'updates')
    if (updates) {
      lines.splice(updates.head, 0, '## Todo', '', item, '')
      return
    }
    trimTrailingBlanks(lines)
    lines.push('', '## Todo', '', item, '')
  })
}

export function updateStamp(date = new Date()): string {
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

export function updateHeading(at: string, author: Author): string {
  return `### ${at} — ${author}`
}

/**
 * The update's lines, with what the parser would read as structure demoted. A
 * `### <stamp> — <author>` line would start an entry of its own, even inside a fence (no
 * fence spans one), so it gets one more `#`. A column-0 `##` would end `## Updates`, and
 * `knot body` would then delete every older update; outside a fence it gets two more, as a
 * `### <stamp> — <author>` could still read as an update heading. Fenced, it stays as typed.
 */
function updateLines(text: string): string[] {
  const lines = text.split('\n').map((line) => (UPDATE_HEADING.test(line) ? `#${line}` : line))
  const fenced = fencedLines(lines)
  return lines.map((line, i) => (!fenced[i] && SECTION_HEADING.test(line) ? `##${line}` : line))
}

/** Newest first, directly beneath `## Updates` (created at EOF when absent). */
export function addUpdate(task: Task, body: string, author: Author): Task {
  const text = unixNewlines(body).trim()
  if (!text) throw new Error('update is empty')
  const heading = updateHeading(updateStamp(), author)
  return mutate(task, (lines, fresh) => {
    const section = scanSections(lines).find((s) => s.kind === 'updates')
    let head = section?.head
    if (section === undefined || head === undefined) {
      trimTrailingBlanks(lines)
      lines.push('', '## Updates')
      head = lines.length - 1
    } else {
      // A hand-typed note with no heading would end up under the new entry's heading
      // and read as part of it. Give it its own heading first.
      let first = head + 1
      while (first < section.end && lines[first].trim() === '') first++
      if (first < section.end && !UPDATE_HEADING.test(lines[first])) lines.splice(first, 0, updateHeading('undated', 'human'), '')
    }
    const block = ['', heading, '', ...updateLines(text)]
    const next = lines[head + 1]
    if (next === undefined || next.trim() !== '') block.push('')
    lines.splice(head + 1, 0, ...block)
    assertReadsAs(task, lines, { body: fresh.body, todos: fresh.todos.length, updates: fresh.updates.length + 1 })
  })
}

export function setTodoText(task: Task, ordinal: number, text: string): Task {
  const value = singleLine(text)
  if (!value) throw new Error('todo text is empty')
  return mutate(task, (lines, fresh) => {
    const { line } = todoLine(fresh, ordinal)
    lines[line] = lines[line].replace(/^(\s*[-*]\s+\[.\]\s+).*$/, (_m, lead: string) => lead + value)
  })
}

export function setTodoState(task: Task, ordinal: number, state: TodoState): Task {
  return mutate(task, (lines, fresh) => {
    const { line } = todoLine(fresh, ordinal)
    lines[line] = lines[line].replace(/\[(.)\]/, `[${MARKER_FOR_STATE[state]}]`)
  })
}

/** Never touches the checkbox line. An empty string removes the detail. */
export function setTodoDetail(task: Task, ordinal: number, detail: string): Task {
  return mutate(task, (lines, fresh) => {
    const item = todoLine(fresh, ordinal)
    const lead = /^\s*/.exec(lines[item.line])![0] + ' '.repeat(DETAIL_INDENT)
    lines.splice(item.line + 1, item.endLine - item.line - 1, ...detailBlock(detail, lead))
  })
}

/** Removes the whole block — checkbox plus detail — or the detail would be stranded. */
export function removeTodo(task: Task, ordinal: number): Task {
  return mutate(task, (lines, fresh) => {
    const item = todoLine(fresh, ordinal)
    lines.splice(item.line, item.endLine - item.line)
  })
}

export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
}

/**
 * Every id ever handed out or deleted, one empty file each. A task file alone can't
 * remember a deleted id, and the `wx` create is the tie-break between concurrent creates.
 */
function idsDir(store: Store): string {
  return path.join(store.dir, '.knot', 'ids')
}

/** False when `id` is already taken. */
function reserveId(store: Store, id: string): boolean {
  fs.mkdirSync(idsDir(store), { recursive: true })
  try {
    fs.writeFileSync(path.join(idsDir(store), id), '', { flag: 'wx' })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
}

function highestId(store: Store): number {
  let max = 0
  for (const file of listFiles(store)) {
    const m = /^t-(\d+)/.exec(path.basename(file))
    if (m) max = Math.max(max, Number(m[1]))
  }
  for (const task of loadAll(store)) {
    const m = /^t-(\d+)$/.exec(task.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  let reserved: string[] = []
  try { reserved = fs.readdirSync(idsDir(store)) }
  catch { /* no create or delete yet */ }
  for (const name of reserved) {
    const m = /^t-(\d+)$/.exec(name)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}

/**
 * One past the highest `t-NNN` seen in filenames, ids or `.knot/ids`. Scanning
 * filenames covers broken-frontmatter files (whose id falls back to the basename);
 * the reservations cover deleted tasks, so a deleted id is never handed out again.
 */
export function nextId(store: Store): string {
  return formatId(highestId(store) + 1)
}

export function formatId(n: number): string {
  return `t-${String(n).padStart(3, '0')}`
}

export function createTask(store: Store, input: CreateTaskInput): Task {
  const title = singleLine(input.title)
  if (!title) throw new Error('title is empty')
  const status = input.status ?? 'backlog'
  if (!TASK_STATUSES.includes(status)) throw new Error(`invalid status: ${status}`)
  const slug = slugify(title)
  const now = new Date().toISOString()
  const tags = normalizeTags(input.tags ?? [])
  const body = unixNewlines(input.body ?? '').trim()
  const todos = (input.todos ?? [])
    .map((t) => (typeof t === 'string' ? { text: t } : t))
    .map((t) => ({ ...t, text: singleLine(t.text) }))
    .filter((t) => t.text !== '')

  const lines = [
    `title: ${yamlScalar(title)}`,
    `status: ${status}`,
    `tags: [${tags.map(yamlScalar).join(', ')}]`,
    ...(input.dir?.trim() ? [`dir: ${yamlScalar(singleLine(input.dir))}`] : []),
    `created: ${now}`,
    `updated: ${now}`,
    '---',
    '',
  ]
  if (body) lines.push(...body.split('\n'), '')
  lines.push('## Todo', '')
  for (const todo of todos) {
    lines.push(`- [${MARKER_FOR_STATE[todo.state ?? 'pending']}] ${todo.text}`, ...detailBlock(todo.detail ?? '', ' '.repeat(DETAIL_INDENT)))
  }
  if (todos.length) lines.push('')
  lines.push('## Updates', '')

  // A concurrent create may have computed the same id: whoever reserves it first keeps
  // it, and the other moves on. The same goes for a file someone made by hand meanwhile.
  for (let n = highestId(store) + 1; ; n++) {
    const id = formatId(n)
    if (!reserveId(store, id)) continue
    const file = path.join(store.dir, slug ? `${id}-${slug}.md` : `${id}.md`)
    const raw = ['---', `id: ${id}`, ...lines].join('\n')
    try {
      fs.writeFileSync(file, raw, { flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
    return parseTask(file, raw)
  }
}

/** Also retires the id (for a task made by hand, which never reserved one) and drops the task's claim. */
export function deleteTask(task: Task): void {
  const store = { dir: path.dirname(task.file) }
  // Retired first: a create in the gap could otherwise take the id, and a retirement that
  // fails leaves the task where it was.
  const m = /^t-(\d+)$/.exec(task.id) ?? /^t-(\d+)/.exec(path.basename(task.file))
  if (m) reserveId(store, formatId(Number(m[1])))
  fs.unlinkSync(task.file)
  dropClaim(store, task.id)
}
