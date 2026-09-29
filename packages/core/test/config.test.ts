import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DEFAULT_UI, configPath, editorCommand, initConfig, loadConfig, resolveVault } from '../src/index.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'knot-config-'))

test('a missing file is not an error', () => {
  const loaded = loadConfig(path.join(tmp(), 'none.toml'))
  assert.equal(loaded.error, undefined)
  assert.deepEqual(loaded.config.ui, DEFAULT_UI)
  assert.equal(DEFAULT_UI.hideDone, false, 'done tasks show unless asked')
})

test('a broken file returns defaults plus the first line of the parse error', () => {
  const file = path.join(tmp(), 'c.toml')
  fs.writeFileSync(file, '[ui\nlist-width = 40\n')
  const loaded = loadConfig(file)
  assert.ok(loaded.error && !loaded.error.includes('\n'))
  assert.deepEqual(loaded.config.ui, DEFAULT_UI)
})

test('values merge over defaults and fall back one key at a time', () => {
  const file = path.join(tmp(), 'c.toml')
  fs.writeFileSync(file, '[ui]\nlist-width = 44\ndetail-share = "wide"\npane-labels = false\nhide-done = true\n\n[keys.normal]\nx = ""\nX = "todo-done"\nbad = 3\n')
  const { config, error } = loadConfig(file)
  assert.equal(error, undefined)
  assert.equal(config.ui.listWidth, 44)
  assert.equal(config.ui.detailShare, DEFAULT_UI.detailShare)
  assert.equal(config.ui.paneLabels, false)
  assert.equal(config.ui.hideDone, true)
  assert.deepEqual(config.keys, { x: '', X: 'todo-done' })
})

test('[claude] clear-between-todos: off by default, read from the file, bad values fall back', () => {
  const dir = tmp()
  assert.equal(loadConfig(path.join(dir, 'none.toml')).config.claude.clearBetweenTodos, false)
  const on = path.join(dir, 'on.toml')
  fs.writeFileSync(on, '[claude]\nclear-between-todos = true\n')
  assert.equal(loadConfig(on).config.claude.clearBetweenTodos, true)
  const bad = path.join(dir, 'bad.toml')
  fs.writeFileSync(bad, '[claude]\nclear-between-todos = "yes"\n')
  assert.equal(loadConfig(bad).config.claude.clearBetweenTodos, false)
})

test('vault resolution: KNOT_DIR, then [vault] dir, then KNOT_ROOT/tasks, then ./tasks', () => {
  const dir = tmp()
  const file = path.join(dir, 'c.toml')
  fs.writeFileSync(file, '[vault]\ndir = "~/somewhere"\n')
  const loaded = loadConfig(file)
  assert.equal(resolveVault(loaded, { KNOT_DIR: '/x', KNOT_ROOT: '/r' }, '/cwd'), '/x')
  assert.equal(resolveVault(loaded, { KNOT_ROOT: '/r' }, '/cwd'), path.join(os.homedir(), 'somewhere'))
  const empty = loadConfig(path.join(dir, 'none.toml'))
  assert.equal(resolveVault(empty, { KNOT_ROOT: '/r' }, '/cwd'), '/r/tasks')
  assert.equal(resolveVault(empty, {}, '/cwd'), '/cwd/tasks')
})

test('configPath: KNOT_CONFIG, else XDG_CONFIG_HOME, else ~/.config', () => {
  assert.equal(configPath({ KNOT_CONFIG: '/a/b.toml' }), '/a/b.toml')
  assert.equal(configPath({ XDG_CONFIG_HOME: '/xdg' }), '/xdg/knot/config.toml')
  assert.equal(configPath({}), path.join(os.homedir(), '.config/knot/config.toml'))
})

test('initConfig writes a commented default that parses clean, and never clobbers', () => {
  const file = path.join(tmp(), 'sub', 'config.toml')
  assert.deepEqual(initConfig(file), { path: file, created: true })
  assert.equal(loadConfig(file).error, undefined)
  fs.writeFileSync(file, '# mine\n')
  assert.deepEqual(initConfig(file), { path: file, created: false })
  assert.equal(fs.readFileSync(file, 'utf8'), '# mine\n')
})

test('the config editor command wins over $VISUAL / $EDITOR', () => {
  const { config } = loadConfig(path.join(tmp(), 'none.toml'))
  assert.equal(editorCommand(config, { VISUAL: 'v', EDITOR: 'e' }), 'v')
  config.editor.command = 'nvim'
  assert.equal(editorCommand(config, { VISUAL: 'v' }), 'nvim')
})
