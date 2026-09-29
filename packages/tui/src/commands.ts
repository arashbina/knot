import { STATUS_LIST, parseStatus, type TaskStatus, type TodoState } from '@knot-tui/core'

export type Command =
  | { kind: 'status'; status: TaskStatus }
  | { kind: 'todo'; state: TodoState }
  | { kind: 'quit' }
  | { kind: 'reload' }
  | { kind: 'none' }
  | { kind: 'error'; message: string }

export const COMMAND_HELP = ':status <s>  :cancel  :reset  :reload  :q'

/** The `:` command line — the TUI's home for changes no single key covers. */
export function parseCommand(input: string): Command {
  const [cmd = '', ...args] = input.trim().split(/\s+/)
  switch (cmd) {
    case '': return { kind: 'none' }
    case 's':
    case 'status': {
      const status = parseStatus(args.join(' '))
      return status ? { kind: 'status', status } : { kind: 'error', message: `status: one of ${STATUS_LIST}` }
    }
    case 'cancel': return { kind: 'todo', state: 'cancelled' }
    case 'reset': return { kind: 'todo', state: 'pending' }
    case 'q':
    case 'quit': return { kind: 'quit' }
    case 'reload': return { kind: 'reload' }
    default: return { kind: 'error', message: `unknown command :${cmd} — ${COMMAND_HELP}` }
  }
}
