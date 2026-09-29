import type { Task, TaskStatus, TodoItem } from './types.js'

export interface TaskFilter { status?: TaskStatus[]; tags?: string[]; text?: string }

/** status: membership. tags: every tag must be present (AND). text: case-insensitive substring of title + body. */
export function filterTasks(tasks: Task[], filter: TaskFilter): Task[] {
  const text = filter.text?.trim().toLowerCase()
  return tasks.filter((t) =>
    (!filter.status?.length || filter.status.includes(t.status)) &&
    (!filter.tags?.length || filter.tags.every((tag) => t.tags.includes(tag))) &&
    (!text || `${t.title} ${t.body}`.toLowerCase().includes(text)))
}

/** Part of the contract: the TUI's initial cursor and the check suite depend on it. */
export const STATUS_ORDER: TaskStatus[] =
  ['in-progress', 'blocked', 'review', 'backlog', 'done']

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) =>
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
    b.updated.localeCompare(a.updated))
}

export function allTags(tasks: Task[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const t of tasks) for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

/** `total` excludes cancelled items. */
export function progress(task: Task): { done: number; total: number } {
  const live = task.todos.filter((t) => t.state !== 'cancelled')
  return { done: live.filter((t) => t.state === 'done').length, total: live.length }
}

/** In-progress first, else the first pending. This is what `knot next` returns. */
export function nextTodo(task: Task): TodoItem | undefined {
  return task.todos.find((t) => t.state === 'in-progress')
    ?? task.todos.find((t) => t.state === 'pending')
}

const MATCH = 1
const BOUNDARY = 8
const FIRST_CHAR = 4
const CONSECUTIVE = 6
const GAP = 1

function isBoundary(text: string, j: number): boolean {
  if (j === 0) return true
  const prev = text[j - 1]
  const ch = text[j]
  if (!/[\p{L}\p{N}]/u.test(prev)) return true
  return (/\p{Ll}/u.test(prev) && /\p{Lu}/u.test(ch)) || (/\p{L}/u.test(prev) && /\p{N}/u.test(ch))
}

export interface FuzzyMatch {
  score: number
  /** Indexes into `text` of the matched letters, for highlighting. */
  positions: number[]
}

/**
 * fzf-style match of `query` as an in-order subsequence of `text`, case-insensitive.
 * Word starts and runs of consecutive letters score up; gaps between matched letters
 * score down; the best-scoring alignment wins. Undefined when it isn't a subsequence,
 * or only is one by scattering letters mid-word — in a long title that matches
 * almost anything.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | undefined {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  // Lowercasing can change length (e.g. İ); then positions wouldn't line up with `text`.
  const aligned = t.length === text.length
  const cased = aligned ? text : t
  const m = q.length
  const n = t.length
  if (m === 0) return { score: 0, positions: [] }
  if (m > n) return undefined

  // best[j]: best score with the current query letter matched at text position j.
  // from[i][j]: where letter i-1 sat in that alignment, to trace positions back.
  let best: number[] = []
  const from: Int32Array[] = []
  for (let i = 0; i < m; i++) {
    const next = new Array<number>(n).fill(-Infinity)
    const back = new Int32Array(n).fill(-1)
    // max over k < j of best[k] + (k + 1) * GAP, so a jump from k costs (j - k - 1) * GAP
    let jump = -Infinity
    let jumpFrom = -1
    for (let j = 0; j < n; j++) {
      if (i > 0 && j > 0 && best[j - 1] + j * GAP > jump) {
        jump = best[j - 1] + j * GAP
        jumpFrom = j - 1
      }
      if (t[j] !== q[i]) continue
      const gain = MATCH + (isBoundary(cased, j) ? BOUNDARY : 0) + (j === 0 ? FIRST_CHAR : 0)
      if (i === 0) {
        next[j] = gain
      } else if (j > 0) {
        const adjacent = best[j - 1] + CONSECUTIVE
        const jumped = jump - j * GAP
        next[j] = Math.max(adjacent, jumped) + gain
        back[j] = adjacent >= jumped ? j - 1 : jumpFrom
      }
    }
    best = next
    from.push(back)
  }

  let end = 0
  for (let j = 1; j < n; j++) if (best[j] > best[end]) end = j
  const score = best[end]
  if (!(score >= m * 2)) return undefined
  const positions: number[] = []
  for (let i = m - 1, j = end; i >= 0; j = from[i][j], i--) positions.unshift(j)
  return { score, positions: aligned ? positions : [] }
}

/**
 * Body text is long enough that a subsequence matches nearly anything, so it only
 * matches as a substring — and only for terms of 3+ letters, since `ci` or `rn`
 * turn up somewhere in almost every paragraph.
 */
function bodyScore(term: string, body: string): number | undefined {
  if (term.length < 3) return undefined
  const at = body.toLowerCase().indexOf(term.toLowerCase())
  if (at < 0) return undefined
  return term.length + (isBoundary(body, at) ? 2 : 0)
}

export interface SearchHit {
  task: Task
  score: number
  /** Matched letters in the title, to highlight. */
  title: number[]
  /** Matched letters per tag, for the tags that matched. */
  tags: Record<string, number[]>
}

function mergePositions(into: number[], add: number[]): number[] {
  return [...new Set([...into, ...add])].sort((a, b) => a - b)
}

/**
 * The TUI's `/`: every whitespace-separated term must match the title or a tag
 * (fuzzy) or the body (substring); `#term` matches tags only. A term scores its best
 * field, and highlights every field it matched. Best match first, ties in the usual
 * sort order; an empty query is just `sortTasks`.
 */
export function searchHits(tasks: Task[], query: string): SearchHit[] {
  const terms = query.trim().split(/\s+/).filter((t) => t !== '' && t !== '#')
  const sorted = sortTasks(tasks)
  if (!terms.length) return sorted.map((task) => ({ task, score: 0, title: [], tags: {} }))

  const hits: SearchHit[] = []
  for (const task of sorted) {
    const hit: SearchHit = { task, score: 0, title: [], tags: {} }
    const matchedEvery = terms.every((term) => {
      const tagOnly = term.startsWith('#')
      const q = tagOnly ? term.slice(1) : term
      const scores: number[] = []
      for (const tag of task.tags) {
        const m = fuzzyMatch(q, tag)
        if (!m) continue
        scores.push(m.score)
        hit.tags[tag] = mergePositions(hit.tags[tag] ?? [], m.positions)
      }
      if (!tagOnly) {
        const m = fuzzyMatch(q, task.title)
        if (m) {
          scores.push(m.score)
          hit.title = mergePositions(hit.title, m.positions)
        }
        const b = bodyScore(q, task.body)
        if (b !== undefined) scores.push(b)
      }
      if (!scores.length) return false
      hit.score += Math.max(...scores)
      return true
    })
    if (matchedEvery) hits.push(hit)
  }
  return hits.sort((a, b) => b.score - a.score)
}

export function searchTasks(tasks: Task[], query: string): Task[] {
  return searchHits(tasks, query).map((h) => h.task)
}

export interface ListView {
  /** The tasks the list draws from: every task, or every task but the done ones. */
  shown: Task[]
  /** `shown`, searched and ordered. */
  hits: SearchHit[]
  /** Done tasks left out of `shown`. */
  hidden: number
  /** Done tasks in all. */
  done: number
  /** Tasks whose frontmatter failed to parse. */
  errors: number
}

/** The TUI's task list, which the web viewer shows too: done tasks optionally hidden, then `searchHits`. */
export function listView(tasks: Task[], opts: { hideDone: boolean; query: string }): ListView {
  const done = tasks.filter((t) => t.status === 'done').length
  const shown = opts.hideDone ? tasks.filter((t) => t.status !== 'done') : tasks
  return {
    shown,
    hits: searchHits(shown, opts.query),
    hidden: tasks.length - shown.length,
    done,
    errors: tasks.filter((t) => t.error).length,
  }
}

/** `text` cut into runs of matched and unmatched letters, for highlighting a `SearchHit`. */
export function matchRuns(text: string, positions: number[]): { text: string; hit: boolean }[] {
  if (!positions.length) return [{ text, hit: false }]
  const hit = new Set(positions)
  const runs: { text: string; hit: boolean }[] = []
  let start = 0
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && hit.has(i) === hit.has(start)) continue
    runs.push({ text: text.slice(start, i), hit: hit.has(start) })
    start = i
  }
  return runs
}

/** `Rework the parser #core #p1` → title + [core, p1]. Only trailing tags: `Fix #122 regression` keeps its hash. */
export function splitTrailingTags(input: string): { title: string; tags: string[] } {
  const words = input.trim().split(/\s+/)
  const tags: string[] = []
  while (words.length > 1 && /^#[^\s#]+$/.test(words[words.length - 1])) {
    tags.unshift(words.pop()!.slice(1))
  }
  return { title: words.join(' '), tags }
}
