/** In workflow order; the picker and `knot help` list them this way. */
export const TASK_STATUSES = [
  'backlog', 'in-progress', 'review', 'done', 'blocked',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** Accepted anywhere a status is read — CLI args, `:status`, frontmatter — but never written. */
export const STATUS_ALIASES: Record<string, TaskStatus> = { wip: 'in-progress', block: 'blocked' }

/** `backlog, in-progress (wip), …`: each status with the aliases that read as it, for help and error text. */
export const STATUS_LIST = TASK_STATUSES.map((s) => {
  const aliases = Object.keys(STATUS_ALIASES).filter((a) => STATUS_ALIASES[a] === s)
  return aliases.length ? `${s} (${aliases.join(', ')})` : s
}).join(', ')

/** Markers follow the Obsidian Tasks plugin so raw files stay meaningful. `X` is valid GFM for done. */
export const TODO_MARKERS = {
  ' ': 'pending', '/': 'in-progress', x: 'done', X: 'done', '-': 'cancelled',
} as const
export type TodoState = (typeof TODO_MARKERS)[keyof typeof TODO_MARKERS]
export const MARKER_FOR_STATE: Record<TodoState, string> = {
  pending: ' ', 'in-progress': '/', done: 'x', cancelled: '-',
}

export interface TodoItem {
  /** 1-based index within the task, stable for as long as the list order is. */
  ordinal: number
  /** 0-based line number of the checkbox — the anchor for surgical edits. */
  line: number
  /** Exclusive end of the block: checkbox line plus its indented detail. */
  endLine: number
  text: string
  state: TodoState
  indent: number
  /** Dedented markdown from the continuation lines. Empty when there is none. */
  detail: string
}

export const DETAIL_INDENT = 4

export type Author = 'human' | 'agent'

export interface TaskUpdate {
  at: string
  author: Author
  body: string
}

export interface Task {
  id: string
  title: string
  status: TaskStatus
  tags: string[]
  created: string
  updated: string
  /** Markdown body with the Todo and Updates sections stripped out. */
  body: string
  todos: TodoItem[]
  updates: TaskUpdate[]
  /** Optional project directory the work happens in (a repo or any folder); where a launched Claude starts. */
  dir?: string
  /** Absolute path of the source file. Derived, never persisted. */
  file: string
  /** Set when the frontmatter failed to parse. The task still loads. */
  error?: string
}

/** A todo to create: just its text, or with its detail (context for whoever picks it up) and state. */
export type NewTodo = string | { text: string; detail?: string; state?: TodoState }

export interface CreateTaskInput {
  title: string
  status?: TaskStatus
  tags?: string[]
  body?: string
  todos?: NewTodo[]
  dir?: string
}
