import React, { type ReactNode } from 'react'
import { Box } from 'ink'
import { LineView } from '../markdown.js'
import { theme } from '../theme.js'
import { lineWidth, padLine, truncateLine, withStyle, type Line, type Seg } from '../text.js'
import { viewport } from '../viewport.js'

/**
 * Ink panes need an explicit width and flexShrink={0}, or short rows collapse and the pane renders ragged.
 * Ink doesn't paint a background under border characters, so without `borderBackgroundColor`
 * the terminal's own background shows through as a band between panes.
 */
export function Pane({ width, height, focused, children }: { width: number; height: number; focused: boolean; children: ReactNode }) {
  return (
    <Box
      width={width}
      height={height}
      flexShrink={0}
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.borderActive : theme.border}
      borderBackgroundColor={theme.bg}
      paddingX={1}
      overflow="hidden"
    >
      {children}
    </Box>
  )
}

/** `rows` of `lines` from `scroll` on. Unlabelled: a label row would eat a content line, so focus reads from the border. */
export function ScrollPane({ lines, scroll, rows, width, height, focused }: {
  lines: Line[]; scroll: number; rows: number; width: number; height: number; focused: boolean
}) {
  const { visible } = viewport(lines, scroll, rows)
  return (
    <Pane width={width} height={height} focused={focused}>
      {visible.map((l, i) => <Row key={i} line={l} />)}
    </Pane>
  )
}

export function Row({ line }: { line: Line }) {
  return (
    <Box width="100%" height={1} flexShrink={0}>
      <LineView line={line} />
    </Box>
  )
}

/** `left` truncated to leave room for `right`, which is pinned to the right edge. */
export function spread(left: Line, right: Line, width: number): Line {
  const rw = lineWidth(right)
  if (!rw) return truncateLine(left, width)
  const l = truncateLine(left, Math.max(0, width - rw - 1))
  return [...l, { text: ' '.repeat(Math.max(1, width - lineWidth(l) - rw)) }, ...right]
}

/** The bar at the left edge of a list's cursor row; accent while the pane has focus. */
export function cursorMark(on: boolean, focused: boolean): Seg {
  return { text: on ? '▌' : ' ', color: focused ? theme.accent : theme.faint }
}

/** The cursor row, padded so its background spans the pane. */
export function cursorRow(line: Line, width: number, focused: boolean): Line {
  return withStyle(padLine(line, width), { bg: focused ? theme.cursor : theme.cursorDim })
}

export function label(text: string, focused: boolean): Line {
  return [{ text, bold: true, color: focused ? theme.accent : theme.dim }]
}
