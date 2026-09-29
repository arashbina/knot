import { matchRuns } from '@knot-tui/core'

/** A styled run of text. A `Line` renders as exactly one terminal line. */
export interface Seg {
  text: string
  color?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  dim?: boolean
  underline?: boolean
  strike?: boolean
  inverse?: boolean
}
export type Line = Seg[]
export type Style = Omit<Seg, 'text'>

const WIDE = /[ᄀ-ᅟ⌚⌛〈〉⏩-⏬⏰⏳◽◾☔☕♈-♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽✅✊✋✨❌❎❓-❕❗➕-➗➰➿⬛⬜⭐⭕⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
const ZERO = /[̀-ͯ​-‏⃐-⃿︀-️]/u

export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0)!
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0) || ZERO.test(ch)) return 0
  return WIDE.test(ch) ? 2 : 1
}

export function strWidth(s: string): number {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

/** Longest prefix of `s` that fits in `width` columns. */
export function sliceWidth(s: string, width: number): string {
  let w = 0
  let out = ''
  for (const ch of s) {
    const cw = charWidth(ch)
    if (w + cw > width) break
    out += ch
    w += cw
  }
  return out
}

export function lineWidth(line: Line): number {
  return line.reduce((w, s) => w + strWidth(s.text), 0)
}

/** Strips control characters (tabs become spaces) so width math holds. */
export function clean(s: string): string {
  return s.replace(/\t/g, '    ').replace(/[\x00-\x1f\x7f]/g, '')
}

export function truncateLine(line: Line, width: number): Line {
  if (lineWidth(line) <= width) return line
  if (width <= 0) return []
  const out: Line = []
  let room = width - 1
  for (const seg of line) {
    const w = strWidth(seg.text)
    if (w <= room) {
      out.push(seg)
      room -= w
      continue
    }
    const head = sliceWidth(seg.text, room)
    out.push({ ...seg, text: `${head}…` })
    return out
  }
  return out
}

/** Pads with spaces to exactly `width`, so a background colour fills the row. */
export function padLine(line: Line, width: number, style: Style = {}): Line {
  const fitted = truncateLine(line, width)
  const gap = width - lineWidth(fitted)
  return gap > 0 ? [...fitted, { ...style, text: ' '.repeat(gap) }] : fitted
}

/** Splits `text` into runs, styling the letters at `positions` (search matches) with `match` over `base`. */
export function highlight(text: string, positions: number[], base: Style, match: Style): Seg[] {
  return matchRuns(text, positions).map((r) => ({ ...base, ...(r.hit ? match : {}), text: r.text }))
}

export function withStyle(line: Line, style: Style): Line {
  return line.map((s) => ({ ...style, ...s, ...(style.bg ? { bg: style.bg } : {}) }))
}

function trimEnd(line: Line): Line {
  const out = [...line]
  while (out.length && out[out.length - 1].text.trim() === '') out.pop()
  return out
}

/**
 * Greedy word wrap across styled runs. Whitespace collapses to one space; a word
 * longer than a whole line is hard-split. `rest` defaults to blanks the width of
 * `first`, giving list items a hanging indent.
 */
export function wrap(segs: Seg[], width: number, first: Line = [], rest?: Line): Line[] {
  const firstP = lineWidth(first) < width ? first : []
  const restP = rest ?? (firstP.length ? [{ text: ' '.repeat(lineWidth(firstP)) }] : [])
  const restPrefix = lineWidth(restP) < width ? restP : []

  const lines: Line[] = []
  let line: Line = [...firstP]
  let w = lineWidth(firstP)
  let empty = true
  const push = () => {
    lines.push(trimEnd(line))
    line = [...restPrefix]
    w = lineWidth(restPrefix)
    empty = true
  }

  for (const seg of segs) {
    for (const part of clean(seg.text).split(/(\s+)/)) {
      if (!part) continue
      if (/^\s+$/.test(part)) {
        if (!empty) {
          line.push({ ...seg, text: ' ' })
          w += 1
        }
        continue
      }
      let text = part
      if (!empty && w + strWidth(text) > width) push()
      while (w + strWidth(text) > width) {
        const head = sliceWidth(text, width - w)
        if (!head) break
        line.push({ ...seg, text: head })
        push()
        text = text.slice(head.length)
      }
      if (text) {
        line.push({ ...seg, text })
        w += strWidth(text)
        empty = false
      }
    }
  }
  if (!empty || lines.length === 0) lines.push(trimEnd(line))
  return lines.map((l) => truncateLine(l, width))
}
