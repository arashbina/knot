import { matchRuns } from '@knot-tui/core'

/** `text` with the letters at `positions` marked, as `/` search matched them. */
export function Highlight({ text, positions }: { text: string; positions: number[] }) {
  if (!positions.length) return text
  return matchRuns(text, positions).map((r, i) => (r.hit ? <mark key={i}>{r.text}</mark> : r.text))
}
