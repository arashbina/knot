import React from 'react'
import { Box } from 'ink'
import { TASK_STATUSES, type TaskStatus } from '@knot-tui/core'
import { STATUS_STYLE, theme } from '../theme.js'
import { padLine, withStyle, type Line } from '../text.js'
import { Row } from './Pane.js'

const INNER = 16

export const PICKER_WIDTH = INNER + 4
export const PICKER_HEIGHT = TASK_STATUSES.length + 3

/** A popup over the panes: numbered statuses, the task's current one ticked, the cursor highlighted. */
export function StatusPicker({ current, cursor, top, left }: { current: TaskStatus; cursor: number; top: number; left: number }) {
  const rows: Line[] = [
    padLine([{ text: 'set status', color: theme.dim }], INNER),
    ...TASK_STATUSES.map((status, i) => {
      const style = STATUS_STYLE[status]
      const line = padLine([
        { text: `${i + 1}  `, color: theme.dim },
        { text: style.label.padEnd(8), color: style.color, bold: true },
        { text: status === current ? ' ✓' : '', color: theme.accent },
      ], INNER)
      return i === cursor ? withStyle(line, { bg: theme.cursor }) : line
    }),
  ]
  return (
    <Box
      position="absolute"
      top={top}
      left={left}
      width={PICKER_WIDTH}
      height={PICKER_HEIGHT}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.borderActive}
      borderBackgroundColor={theme.bg}
      backgroundColor={theme.bg}
      paddingX={1}
    >
      {rows.map((l, i) => <Row key={i} line={l} />)}
    </Box>
  )
}
