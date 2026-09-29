import 'server-only'
import { STATUS_STYLE, TODO_STYLE, palette } from '@knot-tui/core'

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/**
 * The palette the TUI draws with, as CSS custom properties: `--code-bg`,
 * `--author-agent`, `--status-review`, `--todo-done`. The stylesheet uses only these.
 */
export function paletteCss(): string {
  const vars: string[] = []
  const add = (prefix: string, colours: object) => {
    for (const [k, v] of Object.entries(colours)) {
      if (typeof v === 'string') vars.push(`--${prefix}${kebab(k)}:${v}`)
      else add(`${prefix}${kebab(k)}-`, v)
    }
  }
  add('', palette)
  for (const [s, { color }] of Object.entries(STATUS_STYLE)) vars.push(`--status-${s}:${color}`)
  for (const [s, { color }] of Object.entries(TODO_STYLE)) vars.push(`--todo-${s}:${color}`)
  return `:root{${vars.join(';')}}`
}
