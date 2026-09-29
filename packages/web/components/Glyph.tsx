import type { CSSProperties } from 'react'
import { TODO_STYLE, type TodoState } from '@knot-tui/core'

/** A todo's state as the TUI draws it: ○ ◐ ● ⊘ in the state's colour. */
export function Glyph({ state }: { state: TodoState }) {
  return <span className="glyph" style={{ color: `var(--todo-${state})` }} aria-label={state}>{TODO_STYLE[state].glyph}</span>
}

/** The rest of the state's look: bold while in progress, dim once closed, struck through when cancelled. */
export function todoStyle(state: TodoState): CSSProperties {
  const s = TODO_STYLE[state]
  return {
    ...(s.bold ? { fontWeight: 600 } : {}),
    ...(s.dim ? { opacity: 0.6 } : {}),
    ...(s.strike ? { textDecoration: 'line-through' } : {}),
  }
}
