export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** The one slicing helper every pane uses. `offset` is clamped so the last page stays full. */
export function viewport<T>(items: T[], offset: number, rows: number): { visible: T[]; start: number } {
  const start = clamp(offset, 0, Math.max(0, items.length - rows))
  return { visible: items.slice(start, start + rows), start }
}

/** Moves a window start just enough to keep `cursor` visible. */
export function follow(start: number, cursor: number, rows: number, total: number): number {
  let s = start
  if (cursor < s) s = cursor
  if (cursor >= s + rows) s = cursor - rows + 1
  return clamp(s, 0, Math.max(0, total - rows))
}

/** `12–30/80` style position for panes that overflow; empty when everything fits. */
export function position(start: number, rows: number, total: number): string {
  if (total <= rows) return ''
  return `${start + 1}–${Math.min(total, start + rows)}/${total}`
}
