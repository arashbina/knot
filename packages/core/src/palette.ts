import type { TaskStatus, TodoState } from './types.js'

/**
 * Catppuccin-ish, and what both UIs draw with: the TUI through Ink, the web viewer as
 * CSS variables. The only place colours live — no inline hex in components.
 */
export const palette = {
  bg: '#1e1e2e',
  fg: '#cdd6f4',
  dim: '#6c7086',
  faint: '#45475a',
  accent: '#89b4fa',
  border: '#313244',
  borderActive: '#89b4fa',
  code: '#f9e2af',
  codeBg: '#181825',
  link: '#cba6f7',
  quote: '#94e2d5',
  heading: '#f5c2e7',
  error: '#f38ba8',
  /** Letters matched by `/` search. */
  match: '#fab387',
  /** Cursor row background: focused pane / unfocused pane. */
  cursor: '#45475a',
  cursorDim: '#313244',
  author: { agent: '#cba6f7', human: '#94e2d5' },
} as const

export const STATUS_STYLE: Record<TaskStatus, { color: string; label: string }> = {
  'in-progress': { color: '#f9e2af', label: 'WIP' },
  blocked: { color: '#f38ba8', label: 'BLOCK' },
  review: { color: '#cba6f7', label: 'REVIEW' },
  backlog: { color: '#6c7086', label: 'BACKLOG' },
  done: { color: '#a6e3a1', label: 'DONE' },
}

export const TODO_STYLE: Record<TodoState, { glyph: string; color: string; bold?: boolean; dim?: boolean; strike?: boolean }> = {
  pending: { glyph: '○', color: '#cdd6f4' },
  'in-progress': { glyph: '◐', color: '#f9e2af', bold: true },
  done: { glyph: '●', color: '#a6e3a1', dim: true },
  cancelled: { glyph: '⊘', color: '#6c7086', dim: true, strike: true },
}
