import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { defaultConfig, deleteTask, loadAll, openStore } from '@knot-tui/core'
import { DEFAULT_KEYS, buildKeymap } from '../src/keys.js'
import { ensureWelcome, mayCreateVault } from '../src/welcome.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'knot-welcome-'))

test('first launch on a missing default vault creates it with one task that teaches the keys', () => {
  const vault = path.join(tmp(), 'tasks')
  const created = ensureWelcome(vault, DEFAULT_KEYS)
  const tasks = loadAll(openStore(vault))
  assert.equal(tasks.length, 1)
  const [task] = tasks
  assert.equal(task.id, created?.id)
  assert.equal(task.error, undefined)
  assert.equal(task.status, 'in-progress')
  assert.ok(task.todos.length >= 8)
  assert.ok(task.todos.every((t) => t.state === 'pending' && t.detail), 'every step starts pending, with a detail to read')
  assert.deepEqual(task.updates, [])
  assert.match(task.body, /```markdown\n---\ntitle: Ship the release[\s\S]*## Todo[\s\S]*## Updates\n```/, 'the example file stays inside the description')
})

test('only the default vault may be created: not one the user named, and not when a broken config hides the name', () => {
  const loaded = { config: defaultConfig(), path: '/nowhere/config.toml' }
  assert.equal(mayCreateVault(loaded, {}), true)
  assert.equal(mayCreateVault(loaded, { KNOT_DIR: '/tmp/taks' }), false)
  assert.equal(mayCreateVault({ ...loaded, config: { ...defaultConfig(), vault: { dir: '/tmp/taks' } } }, {}), false)
  assert.equal(mayCreateVault({ ...loaded, error: 'unexpected character' }, {}), false)
})

test('with create off, a missing vault is left alone, but an existing empty folder still gets the welcome', () => {
  const vault = path.join(tmp(), 'taks')
  assert.equal(ensureWelcome(vault, DEFAULT_KEYS, { create: false }), undefined)
  assert.equal(fs.existsSync(vault), false)
  // An existing empty folder the user named still gets the welcome.
  const named = tmp()
  assert.ok(ensureWelcome(named, DEFAULT_KEYS, { create: false }))
})

test('the welcome names the keys the user actually has bound', () => {
  const { keys } = buildKeymap({ x: '', X: 'todo-done', dd: '', 'ctrl+d': 'todo-delete' })
  const text = ensureWelcome(tmp(), keys)!.todos.map((t) => `${t.text}\n${t.detail}`).join('\n')
  assert.match(text, /`X`/)
  assert.match(text, /`ctrl\+d`/)
  assert.doesNotMatch(text, /`x`|`dd`/)
})

test('prompts are taught with enter and esc, the only keys they take, whatever the keymap says', () => {
  const { keys } = buildKeymap({ enter: '', o: 'todo-open', esc: '', q: 'todo-close' })
  const todos = ensureWelcome(tmp(), keys)!.todos
  const detail = (key: string) => todos.find((t) => t.text.includes(key))!.detail
  assert.match(detail('status'), /press `enter`/)
  assert.match(detail('searches'), /`enter` keeps the filter and `esc` cancels it/)
})

test('the first step works from where a new user starts, and a task of their own comes before search and Claude', () => {
  const todos = ensureWelcome(tmp(), DEFAULT_KEYS)!.todos.map((t) => t.text)
  assert.match(todos[0], /`J`/, 'J moves the todo cursor from the task list, where focus starts')
  const at = (words: string) => todos.findIndex((t) => t.includes(words))
  assert.ok(at('creates a task') < at('searches'))
  assert.ok(at('creates a task') < at('to Claude'))
})

test('it arrives once: never again after it is deleted, never into a vault already in use', () => {
  const vault = tmp()
  const first = ensureWelcome(vault, DEFAULT_KEYS)!
  assert.equal(ensureWelcome(vault, DEFAULT_KEYS), undefined)
  deleteTask(first)
  assert.equal(ensureWelcome(vault, DEFAULT_KEYS), undefined)
  assert.equal(loadAll(openStore(vault)).length, 0)

  const used = tmp()
  fs.writeFileSync(path.join(used, 't-001-mine.md'), '---\nid: t-001\ntitle: Mine\n---\n')
  assert.equal(ensureWelcome(used, DEFAULT_KEYS), undefined)
  assert.deepEqual(loadAll(openStore(used)).map((t) => t.title), ['Mine'])
})

test('a vault path that is a file gets no welcome and is left untouched', () => {
  const file = path.join(tmp(), 'not-a-dir')
  fs.writeFileSync(file, '')
  assert.equal(ensureWelcome(file, DEFAULT_KEYS), undefined)
  assert.equal(fs.readFileSync(file, 'utf8'), '')
})
