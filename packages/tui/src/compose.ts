import type { Task } from '@knot-tui/core'

const MARKER = '<!-- knot:'

/** What `U` opens in $EDITOR — git-commit style: write above the comment, which is stripped. */
export function updateTemplate(task: Task): string {
  return `\n${MARKER} update for ${task.id} “${task.title}”.
Write the update above this comment; the comment is removed.
Leave it empty (or quit with an error) to cancel.
-->\n`
}

/** The update text from the edited template: everything but the template comment, trimmed. */
export function readComposed(text: string): string {
  const start = text.indexOf(MARKER)
  if (start < 0) return text.trim()
  const end = text.indexOf('-->', start)
  const rest = end < 0 ? '' : text.slice(end + 3)
  return `${text.slice(0, start)}${rest}`.trim()
}
