import 'server-only'
import {
  claimInfo, claimsById, liveClaim, load, loadAll, loadConfig, openStore, resolveVault, sortTasks, taskDetail, taskSummary,
  type ClaimInfo, type LoadedConfig, type Store, type Task, type TaskDetail, type TaskSummary,
} from '@knot-tui/core'

// Read-only by construction: nothing here, or anywhere in this package, imports a
// core mutator (test/readonly.test.ts enforces it). Every call re-reads the vault;
// the markdown is the source of truth, so there's no cache to go stale.

/** Found exactly like the CLI and TUI: $KNOT_DIR → `[vault] dir` → `tasks/`. */
export function vaultDir(config: LoadedConfig = loadConfig()): string {
  return resolveVault(config)
}

function store(): Store {
  return openStore(vaultDir())
}

/** One read of everything a page shows. Throws `NotFoundError` when the vault is missing. */
export interface Snapshot {
  vault: string
  config: LoadedConfig
  /** In the TUI's (and `knot list`'s) order. */
  tasks: Task[]
  claims: Map<string, ClaimInfo>
}

export function snapshot(): Snapshot {
  const config = loadConfig()
  const vault = vaultDir(config)
  const s = openStore(vault)
  // The viewer is never the session holding a claim, so every `mine` is false.
  return { vault, config, tasks: sortTasks(loadAll(s)), claims: claimsById(s) }
}

/** What `knot list --json` prints. */
export function listJson(): TaskSummary[] {
  const { tasks, claims } = snapshot()
  return tasks.map((t) => taskSummary(t, claims.get(t.id)))
}

/** What `knot show <id> --json` prints; undefined when there's no such task. */
export function showJson(id: string): TaskDetail | undefined {
  const s = store()
  const task = load(s, id)
  if (!task) return undefined
  const claim = liveClaim(s, task.id)
  return taskDetail(task, claim && claimInfo(claim))
}
