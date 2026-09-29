import { formatDate, formatStamp, type Task } from '@knot-tui/core'
import { renderMarkdown } from '../markdown.js'
import { STATUS_STYLE, theme } from '../theme.js'
import { lineWidth, truncateLine, wrap, type Line } from '../text.js'

/** id, status label, date, tags — budgeted left to right; the date goes before anything wraps. */
function metaLine(task: Task, width: number, showDate: boolean): Line {
  const status = STATUS_STYLE[task.status]
  const head: Line = [
    { text: task.id, color: theme.dim },
    { text: '  ' },
    { text: status.label, color: status.color, bold: true },
  ]
  const date: Line = showDate && task.updated ? [{ text: `  ${formatDate(task.updated)}`, color: theme.dim }] : []
  const tags: Line = task.tags.length ? [{ text: `  ${task.tags.map((t) => `#${t}`).join(' ')}`, color: theme.accent }] : []
  const full = [...head, ...date, ...tags]
  return truncateLine(lineWidth(full) <= width ? full : [...head, ...tags], width)
}

export interface DetailEdit { title?: Line; tags?: Line }

/**
 * Exactly one terminal line per entry — the viewport slices this array to scroll,
 * so anything that could overflow the width is wrapped or truncated here.
 * The title only appears while it is being renamed; the list owns it otherwise.
 */
export function detailLines(task: Task, width: number, showDate: boolean, edit: DetailEdit = {}): Line[] {
  const lines: Line[] = []
  if (edit.title) lines.push(edit.title)
  lines.push(edit.tags ?? metaLine(task, width, showDate))
  if (task.error) {
    lines.push(...wrap([{ text: `⚠ frontmatter: ${task.error}`, color: theme.error }], width))
  }
  lines.push([])
  lines.push(...(task.body ? renderMarkdown(task.body, width) : [[{ text: 'no description', color: theme.faint }]]))
  for (const u of task.updates) {
    lines.push([])
    const head: Line = [
      { text: '── ', color: theme.faint },
      { text: formatStamp(u.at), color: theme.dim },
      { text: ' · ', color: theme.faint },
      { text: u.author, color: theme.author[u.author] },
      { text: ' ', color: theme.faint },
    ]
    lines.push(truncateLine([...head, { text: '─'.repeat(Math.max(0, width - lineWidth(head))), color: theme.faint }], width))
    lines.push(...renderMarkdown(u.body, width))
  }
  return lines
}
