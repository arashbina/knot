import { useRef, useState } from 'react'
import type { Task } from '@knot-tui/core'
import { clamp } from '../viewport.js'

/**
 * Task selection by id, so a re-sort (every write bumps `updated`) keeps the cursor
 * on the same task. When the selected task disappears, the cursor stays at its index.
 */
export function useSelection(visible: Task[]) {
  const [selectedId, setSelectedId] = useState<string | undefined>(visible[0]?.id)
  const lastIndex = useRef(0)

  let index = selectedId === undefined ? -1 : visible.findIndex((t) => t.id === selectedId)
  if (index < 0) index = clamp(lastIndex.current, 0, Math.max(0, visible.length - 1))
  lastIndex.current = index
  const task: Task | undefined = visible[index]
  if (task && task.id !== selectedId) setSelectedId(task.id)

  return {
    task,
    index,
    select: (id: string) => setSelectedId(id),
    moveTo: (i: number) => {
      const next = visible[clamp(i, 0, visible.length - 1)]
      if (next) setSelectedId(next.id)
    },
  }
}
