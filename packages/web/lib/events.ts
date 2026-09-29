import 'server-only'
import { listClaims, openStore, watchVault } from '@knot-tui/core'
import { vaultDir } from './vault.js'

export type Change = 'tasks' | 'claims'
type Listener = (change: Change) => void

/** A session that dies leaves no file event, so claims are polled — as the TUI does. */
const CLAIM_POLL_MS = 3000

const listeners = new Set<Listener>()
let stop: (() => void) | undefined

/**
 * Calls `listener` when a task file changes or a claim appears or goes stale. One
 * watcher and one poll serve every open tab; they stop when the last tab leaves.
 * Throws `NotFoundError` when the vault is missing.
 */
export function subscribe(listener: Listener): () => void {
  stop ??= start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size) return
    stop?.()
    stop = undefined
  }
}

function start(): () => void {
  const store = openStore(vaultDir())
  const emit = (change: Change) => { for (const l of listeners) l(change) }
  const claimsKey = () => listClaims(store).map((c) => `${c.task}:${c.session}`).sort().join(' ')
  let claims = claimsKey()
  const unwatch = watchVault(store, () => emit('tasks'))
  const poll = setInterval(() => {
    const next = claimsKey()
    if (next === claims) return
    claims = next
    emit('claims')
  }, CLAIM_POLL_MS)
  return () => {
    unwatch()
    clearInterval(poll)
  }
}
