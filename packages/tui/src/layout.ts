import type { UiConfig } from '@knot-tui/core'

/** Smallest the opened-todo pane may get before the middle column stops yielding width. */
export const MIN_TODO = 24

export interface Layout {
  bodyH: number
  listPane: number
  listW: number
  listRows: number
  mainPane: number
  openPane: number
  mainW: number
  openW: number
  detailPaneH: number
  todoPaneH: number
  detailRows: number
  todoRows: number
}

/** Pane widths include border 2 + padding 2; the `…W` values are inner widths. */
export function computeLayout(ui: UiConfig, cols: number, rows: number, drilledIn: boolean): Layout {
  const label = ui.paneLabels ? 1 : 0
  const bodyH = Math.max(6, rows - 2) // minus header and status bar
  const listPane = Math.max(16, Math.min(ui.listWidth, cols - 20))
  const listRows = Math.max(1, Math.floor((bodyH - 2 - label) / 2)) // two lines per task row
  const rest = Math.max(20, cols - listPane)

  const capFloor = drilledIn && ui.maxTodo > 0 ? rest - ui.maxTodo : 0
  const mainPane = drilledIn
    ? Math.min(
        Math.max(10, rest - MIN_TODO),
        Math.max(ui.minDetail, capFloor, Math.round(rest * ui.detailShare)),
      )
    : rest
  const openPane = rest - mainPane

  const detailPaneH = Math.min(bodyH - 3, Math.max(5, Math.round(bodyH * ui.detailHeight)))
  const todoPaneH = bodyH - detailPaneH
  return {
    bodyH,
    listPane,
    listW: listPane - 4,
    listRows,
    mainPane,
    openPane,
    mainW: Math.max(1, mainPane - 4),
    openW: Math.max(1, openPane - 4),
    detailPaneH,
    todoPaneH,
    detailRows: Math.max(1, detailPaneH - 2),
    todoRows: Math.max(1, todoPaneH - 2 - label),
  }
}
