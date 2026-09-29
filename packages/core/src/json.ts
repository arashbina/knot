import { listClaims, type Claim } from './claim.js'
import { progress } from './query.js'
import type { Store } from './store.js'
import type { Task, TaskStatus, TaskUpdate, TodoItem } from './types.js'

// The JSON of `knot list --json` / `knot show --json`, which the web API serves as
// well: one definition, so the CLI and the web can't drift apart.

/** A live claim: which session is working on the task, and whether it's the reader's. */
export interface ClaimInfo { session: string; pid: number; host: string; since: string; mine: boolean }

/** `mySession` is the reader's session id; a reader with none (the web viewer) never holds a claim. */
export function claimInfo(claim: Claim, mySession?: string): ClaimInfo {
  return { session: claim.session, pid: claim.pid, host: claim.host, since: claim.since, mine: claim.session === mySession }
}

/** Every live claim in the vault, by task id. */
export function claimsById(store: Store, mySession?: string): Map<string, ClaimInfo> {
  return new Map(listClaims(store).map((c) => [c.task, claimInfo(c, mySession)]))
}

export interface TaskSummary {
  id: string
  title: string
  status: TaskStatus
  tags: string[]
  todos: { done: number; total: number }
  updated: string
  error?: string
  claim?: ClaimInfo
}

export interface TaskDetail extends TaskSummary {
  created: string
  dir?: string
  file: string
  body: string
  todoItems: TodoItem[]
  updates: TaskUpdate[]
}

export function taskSummary(task: Task, claim?: ClaimInfo): TaskSummary {
  const s: TaskSummary = {
    id: task.id,
    title: task.title,
    status: task.status,
    tags: task.tags,
    todos: progress(task),
    updated: task.updated,
  }
  if (task.error) s.error = task.error
  if (claim) s.claim = claim
  return s
}

export function taskDetail(task: Task, claim?: ClaimInfo): TaskDetail {
  return {
    ...taskSummary(task, claim),
    created: task.created,
    ...(task.dir ? { dir: task.dir } : {}),
    file: task.file,
    body: task.body,
    todoItems: task.todos,
    updates: task.updates,
  }
}
