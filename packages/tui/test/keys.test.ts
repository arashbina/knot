import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Key } from 'ink'
import { TASK_STATUSES } from '@knot-tui/core'
import { ACTIONS, DEFAULT_KEYS, buildKeymap, keyFor, keyName, resolveKey, statusAction } from '../src/keys.js'

const KEY: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  home: false, end: false, return: false, escape: false, ctrl: false, shift: false, tab: false,
  backspace: false, delete: false, meta: false, super: false, hyper: false, capsLock: false, numLock: false,
}

test('resolveKey fires exact hits and holds prefixes of longer bindings', () => {
  assert.deepEqual(resolveKey(DEFAULT_KEYS, '', 'x'), { action: 'todo-done', pending: '' })
  assert.deepEqual(resolveKey(DEFAULT_KEYS, '', 'g'), { pending: 'g' })
  assert.deepEqual(resolveKey(DEFAULT_KEYS, 'g', 'g'), { action: 'move-top', pending: '' })
  assert.deepEqual(resolveKey(DEFAULT_KEYS, 'd', 'd'), { action: 'todo-delete', pending: '' })
})

test('a dead prefix does not swallow the next key', () => {
  assert.deepEqual(resolveKey(DEFAULT_KEYS, 'g', 'j'), { action: 'move-down', pending: '' })
  assert.deepEqual(resolveKey(DEFAULT_KEYS, 'd', 'g'), { pending: 'g' })
  assert.deepEqual(resolveKey(DEFAULT_KEYS, '', 'z'), { pending: '' })
})

test('overrides merge over defaults; "" unbinds; unknown actions and ctrl+h/j are ignored', () => {
  const { keys, ignored } = buildKeymap({ x: '', X: 'todo-done', 'ctrl+d': 'todo-delete', w: 'fly', 'ctrl+h': 'pane-left' })
  assert.equal(keys.x, undefined)
  assert.equal(keys.X, 'todo-done')
  assert.equal(keys['ctrl+d'], 'todo-delete')
  assert.equal(keys.dd, 'todo-delete', 'defaults survive')
  assert.equal(keys['ctrl+h'], undefined)
  assert.deepEqual(ignored.sort(), ['ctrl+h', 'w'])
  assert.equal(keyFor(keys, 'todo-done'), 'X')
})

test('keyName canonicalises Ink key events', () => {
  assert.equal(keyName('', { ...KEY, tab: true, shift: true }), 'shift+tab')
  assert.equal(keyName('', { ...KEY, tab: true }), 'tab')
  assert.equal(keyName('', { ...KEY, return: true }), 'enter')
  assert.equal(keyName('', { ...KEY, escape: true }), 'esc')
  assert.equal(keyName('', { ...KEY, delete: true }), 'backspace')
  assert.equal(keyName('', { ...KEY, backspace: true }), 'backspace')
  assert.equal(keyName('e', { ...KEY, ctrl: true }), 'ctrl+e')
  assert.equal(keyName(' ', KEY), 'space')
  assert.equal(keyName('G', { ...KEY, shift: true }), 'G')
  assert.equal(keyName('', { ...KEY, downArrow: true }), 'down')
})

test('every status has a bindable action; s opens the picker; the direct ones start unbound', () => {
  for (const status of TASK_STATUSES) {
    assert.ok((ACTIONS as readonly string[]).includes(statusAction(status)), status)
    assert.equal(keyFor(DEFAULT_KEYS, statusAction(status)), undefined)
  }
  assert.equal(DEFAULT_KEYS.s, 'status-pick')
  const { keys, ignored } = buildKeymap({ B: 'status-blocked', W: 'status-in-progress' })
  assert.deepEqual(ignored, [])
  assert.equal(resolveKey(keys, '', 'B').action, 'status-blocked')
})

test('H toggles done tasks by default', () => {
  assert.equal(DEFAULT_KEYS.H, 'toggle-done')
  assert.equal(buildKeymap({ '.': 'toggle-done' }).keys['.'], 'toggle-done')
})
