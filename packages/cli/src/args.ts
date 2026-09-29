/** Bad invocation. Exit 1. */
export class UsageError extends Error {}

const VALUE_FLAGS = new Set(['status', 'tag', 'text', 'todo', 'm', 'dir'])
const BOOL_FLAGS = new Set(['json', 'start', 'help', 'append', 'force', 'clear'])
const ALIASES: Record<string, string> = { message: 'm', h: 'help' }

export interface Args {
  pos: string[]
  /** The last occurrence. */
  flag(name: string): string | undefined
  /** Every occurrence — so `--todo a --todo b` accumulates. */
  flagAll(name: string): string[]
  has(name: string): boolean
}

export function parseArgs(argv: string[]): Args {
  const pos: string[] = []
  const flags = new Map<string, string[]>()
  const add = (name: string, value: string) => flags.set(name, [...(flags.get(name) ?? []), value])

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      pos.push(...argv.slice(i + 1))
      break
    }
    const m = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(arg) ?? /^-([a-z])$/.exec(arg)
    if (!m) {
      pos.push(arg)
      continue
    }
    const name = ALIASES[m[1]] ?? m[1]
    const inline: string | undefined = m[2]
    if (BOOL_FLAGS.has(name)) {
      if (inline !== undefined) throw new UsageError(`${arg.split('=')[0]} takes no value`)
      add(name, 'true')
    } else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i]
      if (value === undefined) throw new UsageError(`${arg} needs a value`)
      add(name, value)
    } else {
      throw new UsageError(`unknown flag: ${arg}`)
    }
  }

  return {
    pos,
    flag: (name) => flags.get(name)?.at(-1),
    flagAll: (name) => flags.get(name) ?? [],
    has: (name) => flags.has(name),
  }
}

/** `--tag a,b --tag c` → [a, b, c] */
export function splitList(values: string[]): string[] {
  return values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v !== '')
}
