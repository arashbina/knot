import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  allTags, filterTasks, nextTodo, parseTask, progress, sortTasks, splitTrailingTags,
} from '../src/index.js'

const task = (id: string, status: string, updated: string, tags: string[] = [], todos = '', body = '') =>
  parseTask(`/v/${id}.md`, `---\nid: ${id}\ntitle: Title ${id}\nstatus: ${status}\ntags: [${tags.join(', ')}]\nupdated: ${updated}\n---\n${body}\n\n## Todo\n${todos}`)

test('filterTasks: status membership, tags AND, case-insensitive text over title and body', () => {
  const ts = [
    task('a', 'review', '2026-01-01T00:00:00Z', ['x', 'y'], '', 'Mentions Chokidar'),
    task('b', 'done', '2026-01-01T00:00:00Z', ['x']),
  ]
  assert.deepEqual(filterTasks(ts, { status: ['review'] }).map((t) => t.id), ['a'])
  assert.deepEqual(filterTasks(ts, { tags: ['x', 'y'] }).map((t) => t.id), ['a'])
  assert.deepEqual(filterTasks(ts, { tags: ['x'] }).map((t) => t.id), ['a', 'b'])
  assert.deepEqual(filterTasks(ts, { text: 'chokidar' }).map((t) => t.id), ['a'])
  assert.deepEqual(filterTasks(ts, { text: 'title B' }).map((t) => t.id), ['b'])
})

test('sortTasks orders by status, then most recently updated', () => {
  const ts = [
    task('done', 'done', '2026-09-01T00:00:00Z'),
    task('old-wip', 'in-progress', '2026-01-01T00:00:00Z'),
    task('backlog', 'backlog', '2026-09-01T00:00:00Z'),
    task('new-wip', 'in-progress', '2026-09-01T00:00:00Z'),
    task('blocked', 'blocked', '2026-01-01T00:00:00Z'),
  ]
  assert.deepEqual(sortTasks(ts).map((t) => t.id), ['new-wip', 'old-wip', 'blocked', 'backlog', 'done'])
})

test('allTags counts desc then name asc', () => {
  const ts = [task('a', 'backlog', 'x', ['b', 'a']), task('b', 'backlog', 'x', ['b', 'c'])]
  assert.deepEqual(allTags(ts), [{ tag: 'b', count: 2 }, { tag: 'a', count: 1 }, { tag: 'c', count: 1 }])
})

test('progress excludes cancelled; nextTodo prefers in-progress, then first pending', () => {
  const t = task('a', 'backlog', 'x', [], '- [x] a\n- [-] b\n- [ ] c\n- [/] d\n')
  assert.deepEqual(progress(t), { done: 1, total: 3 })
  assert.equal(nextTodo(t)?.text, 'd')
  const u = task('b', 'backlog', 'x', [], '- [x] a\n- [ ] c\n')
  assert.equal(nextTodo(u)?.text, 'c')
  assert.equal(nextTodo(task('c', 'backlog', 'x', [], '- [x] a\n')), undefined)
})

test('splitTrailingTags only takes trailing #tokens', () => {
  assert.deepEqual(splitTrailingTags('Rework the parser #core #p1'), { title: 'Rework the parser', tags: ['core', 'p1'] })
  assert.deepEqual(splitTrailingTags('Fix #122 regression'), { title: 'Fix #122 regression', tags: [] })
  assert.deepEqual(splitTrailingTags('#only'), { title: '#only', tags: [] })
})
