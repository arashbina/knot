import type { TodoItem } from '@knot-tui/core'
import { inline, renderMarkdown } from '../markdown.js'
import { TODO_STYLE, theme } from '../theme.js'
import { wrap, type Line } from '../text.js'

export function openLines(item: TodoItem, width: number, editHint: string): Line[] {
  const s = TODO_STYLE[item.state]
  const title = wrap(inline(item.text, { color: theme.fg, bold: true, strike: s.strike }), width, [{ text: `${s.glyph} `, color: s.color }])
  const body = item.detail
    ? renderMarkdown(item.detail, width)
    : [[{ text: `no detail — ${editHint}`, color: theme.faint }]]
  return [...title, [], ...body]
}
