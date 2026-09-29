import React from 'react'
import { Text } from 'ink'
import { indentWidth, todoState } from '@knot-tui/core'
import { TODO_STYLE, theme } from './theme.js'
import { clean, padLine, truncateLine, wrap, type Line, type Seg, type Style } from './text.js'

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s*>\s?(.*)$/
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(?:\[(.)\]\s+)?(.*)$/
const TABLE = /^\s*\|/

const INLINE = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)\s]+)[^)]*\)|(?<![\w*])\*(?![\s*])([^*]+?)(?<![\s*])\*(?![\w*])|(?<![\w_])_(?![\s_])([^_]+?)(?<![\s_])_(?![\w_])/g

/** Inline markdown → styled runs: `code`, **bold**, *italic*, ~~strike~~, [links](…), [[wikilinks]]. */
export function inline(text: string, base: Style = {}): Seg[] {
  const segs: Seg[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) segs.push({ ...base, text: text.slice(last, m.index) })
    if (m[2] !== undefined) segs.push({ ...base, text: m[2], color: theme.code, bg: theme.codeBg })
    else if (m[3] !== undefined || m[4] !== undefined) segs.push({ ...base, text: m[3] ?? m[4], bold: true })
    else if (m[5] !== undefined) segs.push({ ...base, text: m[5], strike: true })
    else if (m[6] !== undefined) segs.push({ ...base, text: m[7] ?? m[6], color: theme.link })
    else if (m[8] !== undefined) segs.push({ ...base, text: m[8], color: theme.link, underline: true })
    else segs.push({ ...base, text: m[10] ?? m[11], italic: true })
    last = m.index + m[0].length
  }
  if (last < text.length) segs.push({ ...base, text: text.slice(last) })
  return segs
}

function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line) || TABLE.test(line)
}

/**
 * Renders markdown to terminal lines of at most `width` columns — one entry per
 * terminal line, which is what lets viewports slice the result to scroll.
 */
export function renderMarkdown(src: string, width: number, base: Style = {}): Line[] {
  const lines = src.split('\n').map((l) => l.replace(/\t/g, '    '))
  const out: Line[] = []
  let blank = true
  const emit = (ls: Line[]) => {
    out.push(...ls)
    blank = false
  }
  const gap = () => {
    if (!blank) out.push([])
    blank = true
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      gap()
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const indent = fence[1].length
      const marker = fence[2]
      i++
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        const code = clean(lines[i].slice(Math.min(indent, indentWidth(lines[i]))))
        emit([padLine([{ text: ` ${code}`, color: theme.code, bg: theme.codeBg }], width, { bg: theme.codeBg })])
        i++
      }
      i++
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      emit(wrap(inline(heading[2], { ...base, color: theme.heading, bold: true }), width))
      i++
      continue
    }

    if (RULE.test(line)) {
      emit([[{ text: '─'.repeat(Math.max(0, width)), color: theme.faint }]])
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const parts: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) parts.push(QUOTE.exec(lines[i++])![1])
      const bar: Seg = { text: '│ ', color: theme.quote }
      emit(wrap(inline(parts.join(' '), { ...base, color: theme.quote, italic: true }), width, [bar], [bar]))
      continue
    }

    const item = LIST.exec(line)
    if (item) {
      const indent = indentWidth(item[1])
      const parts = [item[4]]
      i++
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && indentWidth(lines[i]) > indent) {
        parts.push(lines[i++].trim())
      }
      let bullet: Seg
      let style: Style = base
      if (item[3] !== undefined) {
        const s = TODO_STYLE[todoState(item[3])]
        bullet = { text: s.glyph, color: s.color }
        style = { ...base, ...(s.dim ? { dim: true } : {}), ...(s.strike ? { strike: true } : {}) }
      } else {
        bullet = { text: /\d/.test(item[2]) ? item[2] : '•', color: theme.accent }
      }
      const lead: Line = [{ text: ' '.repeat(indent) }, bullet, { text: ' ' }]
      emit(wrap(inline(parts.join(' '), style), width, lead))
      continue
    }

    if (TABLE.test(line)) {
      emit([truncateLine([{ ...base, text: clean(line.trim()) }], width)])
      i++
      continue
    }

    const parts = [line.trim()]
    i++
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) parts.push(lines[i++].trim())
    emit(wrap(inline(parts.join(' '), base), width))
  }
  while (out.length && out[out.length - 1].length === 0) out.pop()
  return out
}

/** One terminal line. Parents give it a `width="100%"` row. */
export function LineView({ line }: { line: Line }) {
  return (
    <Text wrap="truncate-end">
      {line.length === 0 ? ' ' : line.map((s, i) => (
        <Text
          key={i}
          color={s.color}
          backgroundColor={s.bg}
          bold={s.bold}
          italic={s.italic}
          dimColor={s.dim}
          underline={s.underline}
          strikethrough={s.strike}
          inverse={s.inverse}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  )
}
