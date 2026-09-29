import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_UI } from '@knot-tui/core'
import { MIN_TODO, computeLayout } from '../src/layout.js'

test('closed: the middle column takes everything right of the fixed list', () => {
  const l = computeLayout(DEFAULT_UI, 120, 40, false)
  assert.equal(l.listPane, 38)
  assert.equal(l.mainPane, 82)
  assert.equal(l.openPane, 0)
  assert.equal(l.detailPaneH + l.todoPaneH, l.bodyH)
  assert.equal(l.bodyH, 38)
})

test('open: detail-share splits the rest, and the opened pane never drops below MIN_TODO', () => {
  const l = computeLayout(DEFAULT_UI, 120, 40, true)
  assert.equal(l.mainPane + l.openPane, 82)
  assert.equal(l.mainPane, Math.round(82 * 0.55))
  const narrow = computeLayout({ ...DEFAULT_UI, minDetail: 70 }, 120, 40, true)
  assert.equal(narrow.openPane, MIN_TODO)
})

test('max-todo caps the opened pane once the terminal is wide enough; 0 disables it', () => {
  const capped = computeLayout({ ...DEFAULT_UI, maxTodo: 40 }, 240, 40, true)
  assert.equal(capped.openPane, 40)
  const uncapped = computeLayout(DEFAULT_UI, 240, 40, true)
  assert.ok(uncapped.openPane > 40)
})

test('pane labels cost one todo row', () => {
  const on = computeLayout(DEFAULT_UI, 120, 40, false)
  const off = computeLayout({ ...DEFAULT_UI, paneLabels: false }, 120, 40, false)
  assert.equal(off.todoRows, on.todoRows + 1)
})
