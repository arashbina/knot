import { spawn, spawnSync } from 'node:child_process'
import type { Task, TodoItem } from '@knot-tui/core'

/** Everything needed to start a Claude session on a task or one of its todos. */
export interface LaunchPlan {
  task: string
  /** Set for one todo; undefined for the whole task. */
  ordinal?: number
  /** The task's project directory; Claude starts there. */
  dir: string
  /**
   * Session name, shown in Claude's prompt box and `/resume`. It names the task, not
   * the todo: one session per task, so the next todo can go to it.
   */
  name: string
  /** What this request is about, for messages: `t-026 #1` or `t-026`. */
  label: string
  /** The request: asks for the knot skill, which claims the task and keeps it current. */
  prompt: string
  /** So the session's `knot` calls reach the same vault the TUI shows. */
  env: Record<string, string>
  /** Reusing the task's open session: `/clear` it before this request (`[claude] clear-between-todos`). */
  clearContext: boolean
}

export function planLaunch(
  task: Task,
  item: TodoItem | undefined,
  dir: string,
  env: Record<string, string>,
  opts: { clearContext?: boolean } = {},
): LaunchPlan {
  const prompt = item
    ? `Use the knot skill to work on todo ${item.ordinal} of ${task.id} ("${item.text}"). Stop after that todo.`
    : `Use the knot skill to work on ${task.id} ("${task.title}"): start at the first todo that isn't done and continue through the rest.`
  return {
    task: task.id,
    ordinal: item?.ordinal,
    dir,
    name: task.id,
    label: item ? `${task.id} #${item.ordinal}` : task.id,
    prompt,
    env,
    clearContext: opts.clearContext ?? false,
  }
}

export function inHerdr(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV === '1' && Boolean(env.HERDR_PANE_ID)
}

export function herdrSplitArgs(plan: LaunchPlan, pane: string): string[] {
  return [
    'pane', 'split', '--pane', pane, '--direction', 'right', '--cwd', plan.dir,
    ...Object.entries(plan.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    '--focus',
  ]
}

/**
 * The task's agent name in herdr — how the next `c`/`C` finds a session that's still
 * open. herdr's rule: a lowercase letter first, then only `[a-z0-9_-]`, at most 32, and
 * unique among live agents (which one session per task gives for free).
 */
export function herdrName(plan: LaunchPlan): string {
  let base = plan.task.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!/^[a-z]/.test(base)) base = `task-${base}`.replace(/-+$/, '')
  return base.slice(0, 32).replace(/-+$/, '')
}

/**
 * No request here: `agent start` only returns once Claude is idle and ready for input,
 * and a Claude handed its first message at launch goes straight to work — so herdr
 * never sees it ready and times out. The request goes in afterwards, via `agent prompt`.
 */
export function herdrAgentArgs(plan: LaunchPlan, pane: string): string[] {
  return ['agent', 'start', herdrName(plan), '--kind', 'claude', '--pane', pane, '--', '--name', plan.name]
}

/** The new pane's id from `herdr pane split`'s JSON reply. */
export function paneIdFrom(json: string): string | undefined {
  try {
    const id = (JSON.parse(json) as { result?: { pane?: { pane_id?: unknown } } }).result?.pane?.pane_id
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

/** herdr reports failures as JSON (`{"error":{"code":…,"message":…}}`): keep the message, and the code to act on. */
function herdrError(text: string, fallback: string): Error {
  try {
    const error = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }).error
    if (typeof error?.message === 'string') return Object.assign(new Error(error.message), { code: error.code })
  } catch { /* not JSON */ }
  return new Error(text.trim().split('\n')[0] || fallback)
}

const codeOf = (e: unknown) => (e as { code?: unknown }).code

export type Runner = (command: string, args: string[]) => Promise<string>

const runProcess: Runner = (command, args) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(herdrError(err || out, `${command} exited ${code}`))))
  })
}

/** How long to wait for a Claude that's stuck at startup — typically asking whether to trust a new folder. */
const STARTUP_WAIT_MS = 5 * 60_000

/**
 * A just-split pane's shell takes a moment to reach its prompt (zsh reading its
 * config), and herdr refuses `agent start` with `agent_pane_busy` until it does.
 */
const SHELL_READY_ATTEMPTS = 40
const SHELL_READY_DELAY_MS = 250

export interface HerdrDeps {
  env?: NodeJS.ProcessEnv
  run?: Runner
  /** Progress for the status bar, e.g. "Claude is waiting for you in pane …". */
  notify?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** `herdr <args>`, resolving to its stdout. */
type Herdr = (args: string[]) => Promise<string>

async function startWhenShellReady(plan: LaunchPlan, pane: string, herdr: Herdr, sleep: (ms: number) => Promise<void>) {
  for (let attempt = 1; ; attempt++) {
    try {
      await herdr(herdrAgentArgs(plan, pane))
      return
    } catch (e) {
      if (codeOf(e) !== 'agent_pane_busy') throw e
      if (attempt >= SHELL_READY_ATTEMPTS) {
        throw new Error(`the shell in pane ${pane} never reached its prompt, so Claude couldn't start there (${(e as Error).message})`)
      }
      await sleep(SHELL_READY_DELAY_MS)
    }
  }
}

async function hasAgent(herdr: Herdr, pane: string): Promise<boolean> {
  try {
    const reply = JSON.parse(await herdr(['pane', 'get', pane])) as { result?: { pane?: { agent?: unknown } } }
    return Boolean(reply.result?.pane?.agent)
  } catch {
    return false
  }
}

/** The task's session, if herdr still has it: its pane and lifecycle state. */
async function openSession(herdr: Herdr, name: string): Promise<{ pane: string; status: string } | undefined> {
  try {
    const reply = JSON.parse(await herdr(['agent', 'get', name])) as { result?: { agent?: { pane_id?: unknown; agent_status?: unknown } } }
    const agent = reply.result?.agent
    return typeof agent?.pane_id === 'string' ? { pane: agent.pane_id, status: String(agent.agent_status ?? 'unknown') } : undefined
  } catch {
    return undefined // not found: it was closed, or never started
  }
}

/**
 * The task's session is still open: send the request there instead of opening another.
 * Only when it's ready for input (`idle` / `done`) — typing into one that's working,
 * waiting on a question, or unclassifiable would interfere with it.
 */
async function reuseSession(plan: LaunchPlan, session: { pane: string; status: string }, herdr: Herdr): Promise<string> {
  const { pane, status } = session
  if (status !== 'idle' && status !== 'done') {
    throw new Error(`Claude for ${plan.task} is busy (${status}) in pane ${pane} — let it finish, or talk to it there`)
  }
  if (plan.clearContext) {
    await herdr(['agent', 'prompt', pane, '/clear'])
    await herdr(['agent', 'wait', pane, '--until', 'idle', '--timeout', '15000']).catch(() => undefined)
  }
  await herdr(['agent', 'prompt', pane, plan.prompt])
  await herdr(['agent', 'focus', pane]).catch(() => undefined)
  return `sent ${plan.label} to Claude's open session in pane ${pane}${plan.clearContext ? ' (context cleared)' : ''}`
}

/**
 * Inside herdr: the task's own session if it's still open; otherwise a new pane beside
 * the TUI, so the list stays in view and updates live while Claude works.
 * New session: split → start Claude → send the request once it's ready.
 *
 * A failed `agent start` doesn't mean Claude isn't running: it may be waiting on the
 * user (a trust-this-folder question) or just slow. So a pane is only closed when no
 * agent ever appeared in it — closing one with Claude inside would kill the session.
 */
export async function launchInHerdr(plan: LaunchPlan, deps: HerdrDeps = {}): Promise<string> {
  const { env = process.env, run = runProcess, notify = () => undefined, sleep = realSleep } = deps
  const bin = env.HERDR_BIN_PATH || 'herdr'
  const herdr: Herdr = (args) => run(bin, args)
  const open = await openSession(herdr, herdrName(plan))
  if (open) return reuseSession(plan, open, herdr)

  const pane = paneIdFrom(await herdr(herdrSplitArgs(plan, env.HERDR_PANE_ID!)))
  if (!pane) throw new Error('herdr did not report the new pane')
  try {
    await startWhenShellReady(plan, pane, herdr, sleep)
  } catch (e) {
    if (!(await hasAgent(herdr, pane))) {
      await herdr(['pane', 'close', pane]).catch(() => undefined)
      throw e
    }
    notify(`Claude in pane ${pane} isn't ready yet — if it's asking something, answer it there; the request goes in once it's ready`)
    try {
      await herdr(['agent', 'wait', pane, '--until', 'idle', '--timeout', String(STARTUP_WAIT_MS)])
    } catch {
      throw new Error(`Claude in pane ${pane} never became ready, so the request wasn't sent — type it there: ${plan.prompt}`)
    }
  }
  await herdr(['agent', 'prompt', pane, plan.prompt])
  return `Claude is working on ${plan.label} in pane ${pane}`
}

export function takeoverCommand(plan: LaunchPlan) {
  return { command: 'claude', args: ['--name', plan.name, plan.prompt], cwd: plan.dir, env: plan.env }
}

/**
 * Anywhere else: Claude takes over this terminal, like the `$EDITOR` hand-off.
 * Call inside `suspendTerminal`; returns when the session ends.
 */
export function runTakeover(plan: LaunchPlan): number {
  const { command, args, cwd, env } = takeoverCommand(plan)
  const r = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
  if (r.error) throw r.error
  return r.status ?? 1
}
