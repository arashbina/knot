import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Store } from './store.js'

/**
 * "A session is working on this task." Runtime coordination between agent sessions,
 * not task content — so it lives in a hidden sidecar folder, never in the markdown.
 * A claim is tied to a live process: when the session exits, the claim is stale.
 */
export interface Claim {
  task: string
  session: string
  pid: number
  /** Start time of `pid`, so a reused pid isn't mistaken for the original process. */
  started: string
  host: string
  since: string
}

export type Session = Pick<Claim, 'session' | 'pid' | 'started' | 'host'>

/** pid → its start time, or undefined when no such process is running. */
export type ProcessProbe = (pid: number) => string | undefined

/** A zombie (exited, not yet reaped by its parent) still reports a start time, so check the state too. */
export const processStart: ProcessProbe = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const r = spawnSync('ps', ['-o', 'stat=,lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  const m = r.status === 0 ? /^\s*(\S+)\s+(.+?)\s*$/.exec(r.stdout ?? '') : null
  return m && !m[1].startsWith('Z') ? m[2] : undefined
}

/** Running inside a Claude Code session — the only kind of caller a claim locks out. */
export function inClaude(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CLAUDE_CODE_SESSION_ID) && Number(env.CLAUDE_PID) > 0
}

/**
 * The shell that ran `knot`. bin/knot passes it in `KNOT_CALLER_PID`: tsx runs the CLI
 * in a child process, so the CLI's own parent is tsx's wrapper, which exits with the command.
 */
function callerPid(env: NodeJS.ProcessEnv): number {
  const pid = Number(env.KNOT_CALLER_PID)
  return Number.isInteger(pid) && pid > 0 ? pid : process.ppid
}

/** The id `claimTask` records for the caller: the Claude session, else the calling shell. */
export function sessionId(env: NodeJS.ProcessEnv = process.env, ppid = callerPid(env)): string {
  return inClaude(env) ? env.CLAUDE_CODE_SESSION_ID! : `pid-${ppid}`
}

/**
 * The caller's session. Inside Claude Code that's `CLAUDE_CODE_SESSION_ID`, tied to
 * the long-lived Claude process (`CLAUDE_PID`) — not the short-lived shell each
 * command runs in. Outside it, the shell that ran `knot`.
 */
export function currentSession(env: NodeJS.ProcessEnv = process.env, ppid = callerPid(env), probe: ProcessProbe = processStart): Session {
  const pid = inClaude(env) ? Number(env.CLAUDE_PID) : ppid
  return { session: sessionId(env, ppid), pid, started: probe(pid) ?? '', host: os.hostname() }
}

function claimsDir(store: Store): string {
  return path.join(store.dir, '.knot', 'claims')
}

/** The id is frontmatter text, so it is encoded: one like `../../x` must not name a file outside the folder. */
function claimFile(store: Store, id: string): string {
  // The id is frontmatter text: escape only what could leave the folder (and `%`, so the
  // mapping stays one-to-one). Encoding everything would triple a non-ASCII id past NAME_MAX.
  return path.join(claimsDir(store), `${id.replace(/[%/\\\0]/g, encodeURIComponent)}.json`)
}

function readClaim(file: string): Claim | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Claim }
  catch { return undefined }
}

/** Another machine's processes can't be checked, so its claims count as live. */
export function isLive(claim: Claim, probe: ProcessProbe = processStart): boolean {
  if (claim.host !== os.hostname()) return true
  return probe(claim.pid) === claim.started
}

export function liveClaim(store: Store, id: string, probe: ProcessProbe = processStart): Claim | undefined {
  const claim = readClaim(claimFile(store, id))
  return claim && isLive(claim, probe) ? claim : undefined
}

/** Every live claim in the vault. */
export function listClaims(store: Store, probe: ProcessProbe = processStart): Claim[] {
  const dir = claimsDir(store)
  let names: string[]
  try { names = fs.readdirSync(dir) }
  catch { return [] }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => readClaim(path.join(dir, n)))
    .filter((c): c is Claim => Boolean(c && isLive(c, probe)))
}

export type ClaimResult = { ok: true; claim: Claim; resumed: boolean } | { ok: false; holder: Claim }

interface ClaimOptions { session?: Session; probe?: ProcessProbe; force?: boolean }

/** The caller, and the live claim on `id` if there is one; `blocked` when it's someone else's and not forced. */
function standing(store: Store, id: string, opts: ClaimOptions) {
  const probe = opts.probe ?? processStart
  const me = opts.session ?? currentSession(process.env, undefined, probe)
  const held = liveClaim(store, id, probe)
  return { me, held, blocked: Boolean(held && held.session !== me.session && !opts.force) }
}

export function claimTask(store: Store, id: string, opts: ClaimOptions = {}): ClaimResult {
  const { me, held, blocked } = standing(store, id, opts)
  if (blocked) return { ok: false, holder: held! }
  const resumed = held?.session === me.session
  const claim: Claim = { task: id, ...me, since: resumed ? held!.since : new Date().toISOString() }
  const file = claimFile(store, id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(claim, null, 2)}\n`)
  fs.renameSync(tmp, file)
  return { ok: true, claim, resumed }
}

/** A Claude session's UUID is known by its first 8 characters; cutting a `pid-<n>` would name another process. */
export function shortSession(session: string): string {
  return session.startsWith('pid-') ? session : session.slice(0, 8)
}

/** Drops the claim on `id` whoever holds it: for a task that no longer exists. */
export function dropClaim(store: Store, id: string): void {
  fs.rmSync(claimFile(store, id), { force: true })
}

/** Removes the claim if the caller holds it (or it's stale, or forced). False when someone else holds it. */
export function releaseTask(store: Store, id: string, opts: ClaimOptions = {}): boolean {
  if (standing(store, id, opts).blocked) return false
  fs.rmSync(claimFile(store, id), { force: true })
  return true
}
