import React from 'react'
import { progress, type SearchHit } from '@knot-tui/core'
import { STATUS_STYLE, theme } from '../theme.js'
import { highlight, truncateLine, wrap, type Line, type Seg } from '../text.js'
import { viewport } from '../viewport.js'
import { Pane, Row, cursorMark, cursorRow, label, spread } from './Pane.js'

const MATCH = { color: theme.match, bold: true }

function tagSegs({ task, tags }: SearchHit): Seg[] {
  return task.tags.flatMap((tag) => [
    { text: ' #', color: theme.faint },
    ...highlight(tag, tags[tag] ?? [], { color: theme.faint }, MATCH),
  ])
}

function rowLines(hit: SearchHit, width: number, selected: boolean, focused: boolean, claimed: boolean): Line[] {
  const { task } = hit
  const mark = cursorMark(selected, focused)
  const p = progress(task)
  const status = STATUS_STYLE[task.status]
  const title: Line = [
    mark,
    ...(task.error ? [{ text: '⚠ ', color: theme.error }] : []),
    ...highlight(task.title, hit.title, { color: theme.fg, bold: selected }, MATCH),
  ]
  const meta: Line = [
    mark,
    { text: status.label, color: status.color },
    ...(claimed ? [{ text: ' ◆ claude', color: theme.author.agent }] : []),
    ...(p.total ? [{ text: `  ${p.done}/${p.total}`, color: theme.dim }] : []),
    ...(task.tags.length ? [{ text: ' ' }, ...tagSegs(hit)] : []),
    ...(task.error ? [{ text: '  frontmatter error', color: theme.error }] : []),
  ]
  const lines = [title, meta].map((l) => truncateLine(l, width))
  return selected ? lines.map((l) => cursorRow(l, width, focused)) : lines
}

export interface TaskListProps {
  /** Visible tasks in order, with the letters `/` matched. */
  hits: SearchHit[]
  /** Shown in place of rows when `hits` is empty. */
  empty: string
  /** Task id → session, for tasks a live Claude session is working on. */
  claims: Record<string, string>
  index: number
  start: number
  rows: number
  width: number
  paneWidth: number
  height: number
  focused: boolean
  labels: boolean
  filter: string
}

/** Title and per-task progress live here and nowhere else. */
export function TaskList(p: TaskListProps) {
  const { visible, start } = viewport(p.hits, p.start, p.rows)
  const lines: Line[] = []
  if (p.labels) {
    const left: Line = [...label('TASKS', p.focused), ...(p.filter ? [{ text: `  /${p.filter}`, color: theme.accent }] : [])]
    const right: Line = p.hits.length ? [{ text: `${p.index + 1}/${p.hits.length}`, color: theme.dim }] : []
    lines.push(spread(left, right, p.width))
  }
  visible.forEach((hit, i) => lines.push(...rowLines(hit, p.width, start + i === p.index, p.focused, hit.task.id in p.claims)))
  if (!p.hits.length) lines.push(...wrap([{ text: p.empty, color: theme.dim }], p.width))
  return (
    <Pane width={p.paneWidth} height={p.height} focused={p.focused}>
      {lines.map((l, i) => <Row key={i} line={l} />)}
    </Pane>
  )
}
