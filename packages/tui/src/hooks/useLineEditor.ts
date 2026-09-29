import { useRef, useState } from 'react'
import type { Key } from 'ink'
import { theme } from '../theme.js'
import { clean, lineWidth, strWidth, truncateLine, type Line } from '../text.js'

interface EditState { value: string; cursor: number }

export interface LineEditor extends EditState {
  start(value: string): void
  /** The latest state, even before React re-renders. */
  current(): EditState
  handle(input: string, key: Key): 'commit' | 'cancel' | 'change' | undefined
}

/** Single-line inline editor. Enter commits, Esc cancels; readline-ish ctrl keys. */
export function useLineEditor(): LineEditor {
  const [state, setState] = useState<EditState>({ value: '', cursor: 0 })
  const ref = useRef(state)
  const set = (value: string, cursor: number) => {
    ref.current = { value, cursor }
    setState(ref.current)
  }

  return {
    ...state,
    start: (value) => set(value, Array.from(value).length),
    current: () => ref.current,
    handle(input, key) {
      if (key.return) return 'commit'
      if (key.escape) return 'cancel'
      const chars = Array.from(ref.current.value)
      const at = ref.current.cursor
      const edit = (next: string[], cursor: number) => {
        set(next.join(''), cursor)
        return 'change' as const
      }
      if (key.backspace || key.delete) {
        return at > 0 ? edit([...chars.slice(0, at - 1), ...chars.slice(at)], at - 1) : undefined
      }
      if (key.leftArrow) return edit(chars, Math.max(0, at - 1))
      if (key.rightArrow) return edit(chars, Math.min(chars.length, at + 1))
      if (key.home || (key.ctrl && input === 'a')) return edit(chars, 0)
      if (key.end || (key.ctrl && input === 'e')) return edit(chars, chars.length)
      if (key.ctrl && input === 'u') return edit(chars.slice(at), 0)
      if (key.ctrl && input === 'k') return edit(chars.slice(0, at), at)
      if (key.ctrl && input === 'w') {
        let from = at
        while (from > 0 && chars[from - 1] === ' ') from--
        while (from > 0 && chars[from - 1] !== ' ') from--
        return edit([...chars.slice(0, from), ...chars.slice(at)], from)
      }
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return undefined
      const text = Array.from(clean(input.replace(/[\r\n]+/g, ' ')))
      if (!text.length) return undefined
      return edit([...chars.slice(0, at), ...text, ...chars.slice(at)], at + text.length)
    },
  }
}

/** The editor as one terminal line, scrolled horizontally so the cursor stays in view. */
export function inputLine(prefix: Line, value: string, cursor: number, width: number): Line {
  const chars = Array.from(value)
  const room = Math.max(2, width - lineWidth(prefix))
  let start = 0
  while (start < cursor && strWidth(chars.slice(start, cursor).join('')) > room - 1) start++
  return truncateLine([
    ...prefix,
    { text: chars.slice(start, cursor).join(''), color: theme.fg },
    { text: chars[cursor] ?? ' ', inverse: true },
    { text: chars.slice(cursor + 1).join(''), color: theme.fg },
  ], width)
}
