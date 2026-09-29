import type { Key } from 'ink'
import type { TaskStatus } from '@knot-tui/core'

/** Every binding goes through an action: adding a keystroke means an action plus a default binding. */
export const ACTIONS = [
  'pane-left', 'pane-right', 'pane-next', 'pane-prev',
  'move-down', 'move-up', 'move-top', 'move-bottom',
  'todo-down', 'todo-up', 'todo-done', 'todo-start',
  'todo-add', 'todo-delete', 'todo-open', 'todo-close',
  'task-new', 'task-delete', 'rename', 'edit-tags', 'edit-file',
  'search', 'command', 'config-edit', 'config-reload', 'quit',
  'status-pick', 'toggle-done', 'update-add', 'update-edit', 'claude-todo', 'claude-task',
  // One per status, unbound by default — bind them in [keys.normal] to skip the picker.
  'status-backlog', 'status-in-progress', 'status-review', 'status-done', 'status-blocked',
] as const
export type Action = (typeof ACTIONS)[number]

export type StatusAction = `status-${TaskStatus}`
export const statusAction = (status: TaskStatus): StatusAction => `status-${status}`

/** The status a direct `status-<name>` action sets; undefined for every other action (including the picker). */
export function statusOfAction(action: Action): TaskStatus | undefined {
  return action.startsWith('status-') && action !== 'status-pick' ? (action.slice('status-'.length) as TaskStatus) : undefined
}

/** Key name (or sequence of names) → action. */
export type Keymap = Record<string, Action>

export const DEFAULT_KEYS: Keymap = {
  h: 'pane-left', l: 'pane-right', left: 'pane-left', right: 'pane-right',
  tab: 'pane-next', 'shift+tab': 'pane-prev',
  j: 'move-down', k: 'move-up', down: 'move-down', up: 'move-up',
  gg: 'move-top', G: 'move-bottom',
  J: 'todo-down', K: 'todo-up',
  x: 'todo-done', space: 'todo-start',
  o: 'todo-add', dd: 'todo-delete',
  enter: 'todo-open', esc: 'todo-close',
  n: 'task-new', D: 'task-delete',
  i: 'rename', t: 'edit-tags', e: 'edit-file',
  '/': 'search', ':': 'command', q: 'quit',
  s: 'status-pick', H: 'toggle-done',
  u: 'update-add', U: 'update-edit',
  c: 'claude-todo', C: 'claude-task',
  'ctrl+e': 'config-edit', 'ctrl+r': 'config-reload',
}

/** The terminal sends these as backspace and newline; Ink never reports the ctrl flag. */
const UNBINDABLE = new Set(['ctrl+h', 'ctrl+j'])

/**
 * Merged, never replaced: overrides layer over the defaults, `key = ""` unbinds,
 * unknown actions and unbindable keys are ignored rather than errors.
 */
export function buildKeymap(overrides: Record<string, string> = {}): { keys: Keymap; ignored: string[] } {
  const keys: Keymap = { ...DEFAULT_KEYS }
  const ignored: string[] = []
  for (const [name, action] of Object.entries(overrides)) {
    if (UNBINDABLE.has(name.toLowerCase())) ignored.push(name)
    else if (action === '') delete keys[name]
    else if ((ACTIONS as readonly string[]).includes(action)) keys[name] = action as Action
    else ignored.push(name)
  }
  return { keys, ignored }
}

/** Canonical key name from Ink's (input, key) pair. Tab is checked before shift. */
export function keyName(input: string, key: Key): string {
  if (key.tab) return key.shift ? 'shift+tab' : 'tab'
  if (key.return) return 'enter'
  if (key.escape) return 'esc'
  if (key.backspace || key.delete) return 'backspace'
  if (key.upArrow) return 'up'
  if (key.downArrow) return 'down'
  if (key.leftArrow) return 'left'
  if (key.rightArrow) return 'right'
  if (key.ctrl && input) return `ctrl+${input.toLowerCase()}`
  if (input === ' ') return 'space'
  return input
}

/**
 * Sequences are longer names matched by prefix:
 * 1. exact hit on pending + name → fire, clear pending;
 * 2. a strictly longer binding starts with it → hold as pending;
 * 3. pending was non-empty → re-resolve `name` alone, so a dead `g` doesn't swallow the next key;
 * 4. otherwise clear pending.
 */
export function resolveKey(keys: Keymap, pending: string, name: string): { action?: Action; pending: string } {
  const seq = pending + name
  if (Object.hasOwn(keys, seq)) return { action: keys[seq], pending: '' }
  if (Object.keys(keys).some((k) => k.length > seq.length && k.startsWith(seq))) return { pending: seq }
  if (pending) return resolveKey(keys, '', name)
  return { pending: '' }
}

/** First key bound to `action`, for the status-bar hints — so a rebind is reflected, not stale. */
export function keyFor(keys: Keymap, action: Action): string | undefined {
  return Object.keys(keys).find((k) => keys[k] === action)
}
