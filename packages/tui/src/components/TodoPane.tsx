import React from 'react'
import type { TodoItem } from '@knot-tui/core'
import { inline } from '../markdown.js'
import { DETAIL_MARK, OPEN_MARK, TODO_STYLE, theme } from '../theme.js'
import { lineWidth, padLine, truncateLine, type Line } from '../text.js'
import { position, viewport } from '../viewport.js'
import { Pane, Row, cursorMark, cursorRow, label, spread } from './Pane.js'

export function todoRow(item: TodoItem, width: number, opts: { cursor: boolean; focused: boolean; open: boolean; edit?: Line }): Line {
  const s = TODO_STYLE[item.state]
  const lead: Line = [
    cursorMark(opts.cursor, opts.focused),
    { text: `${s.glyph} `, color: s.color },
  ]
  let line: Line
  if (opts.edit) {
    line = [...lead, ...opts.edit]
  } else {
    const tail: Line = item.detail ? [{ text: ` ${opts.open ? OPEN_MARK : DETAIL_MARK}`, color: opts.open ? theme.accent : theme.dim }] : []
    const text = inline(item.text, { color: s.dim ? theme.dim : theme.fg, bold: s.bold, strike: s.strike })
    line = [...truncateLine([...lead, ...text], width - lineWidth(tail)), ...tail]
  }
  line = truncateLine(line, width)
  return opts.cursor ? cursorRow(line, width, opts.focused) : line
}

export interface TodoPaneProps {
  todos: TodoItem[]
  cursor: number
  start: number
  rows: number
  width: number
  paneWidth: number
  height: number
  focused: boolean
  drilled: boolean
  labels: boolean
  progress: { done: number; total: number }
  /** The inline editor, rendered in place of the cursor row's text. */
  editing?: Line
  /** The inline editor for a new todo, rendered as an extra last row. */
  adding?: Line
  emptyHint: string
}

/**
 * The cursor is always drawn — dimmed when this pane isn't focused — because todo
 * keys act on it from any pane.
 */
export function TodoPane(p: TodoPaneProps) {
  const rows: Line[] = p.todos.map((item, i) => todoRow(item, p.width, {
    cursor: i === p.cursor && !p.adding,
    focused: p.focused,
    open: p.drilled && i === p.cursor,
    edit: i === p.cursor ? p.editing : undefined,
  }))
  if (p.adding) rows.push(padLine([{ text: '▌', color: theme.accent }, { text: `${TODO_STYLE.pending.glyph} `, color: theme.fg }, ...p.adding], p.width))
  if (!rows.length) rows.push([{ text: p.emptyHint, color: theme.faint }])

  const { visible, start } = viewport(rows, p.start, p.rows)
  const lines: Line[] = []
  if (p.labels) {
    const left: Line = [...label('TODO', p.focused), { text: `  ${p.progress.done}/${p.progress.total}`, color: theme.dim }]
    lines.push(spread(left, [{ text: position(start, p.rows, rows.length), color: theme.dim }], p.width))
  }
  lines.push(...visible)
  return (
    <Pane width={p.paneWidth} height={p.height} focused={p.focused}>
      {lines.map((l, i) => <Row key={i} line={l} />)}
    </Pane>
  )
}
