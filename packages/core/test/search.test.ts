import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fuzzyMatch, parseTask, searchHits, searchTasks, sortTasks, yamlScalar, type Task } from '../src/index.js'

let n = 0
const task = (title: string, tags: string[] = [], body = '', status = 'backlog'): Task =>
  parseTask(`/v/t-${++n}.md`, `---\nid: t-${n}\ntitle: ${yamlScalar(title)}\nstatus: ${status}\ntags: [${tags.join(', ')}]\nupdated: 2026-09-01T00:00:00Z\n---\n${body}\n`)

const TASKS = [
  task('Refresh token rotation breaks under concurrent requests', ['auth', 'bug', 'p1']),
  task('Flaky e2e test: checkout flow times out', ['test', 'flaky']),
  task('Cache invalidation for product catalog', ['api', 'perf']),
  task('Spike: evaluate SQLite for the local cache', ['spike']),
  task('Write onboarding guide', ['docs'], 'Explain the Postgres setup.'),
  task('Authentication audit', ['security']),
]
const titles = (ts: Task[]) => ts.map((t) => t.title)

test('matches tags as well as titles', () => {
  assert.deepEqual(titles(searchTasks(TASKS, 'security')), ['Authentication audit'])
  assert.deepEqual(titles(searchTasks(TASKS, 'p1')), ['Refresh token rotation breaks under concurrent requests'])
  assert.deepEqual(titles(searchTasks(TASKS, 'auth')).sort(), [
    'Authentication audit',
    'Refresh token rotation breaks under concurrent requests',
  ])
})

test('#term matches tags only', () => {
  assert.deepEqual(titles(searchTasks(TASKS, '#auth')), ['Refresh token rotation breaks under concurrent requests'])
  assert.deepEqual(titles(searchTasks(TASKS, '#fla')), ['Flaky e2e test: checkout flow times out'])
})

test('is fuzzy: letters in order, not necessarily adjacent', () => {
  assert.deepEqual(titles(searchTasks(TASKS, 'rtr')), ['Refresh token rotation breaks under concurrent requests'])
  assert.deepEqual(titles(searchTasks(TASKS, 'tokrot')), ['Refresh token rotation breaks under concurrent requests'])
  assert.deepEqual(titles(searchTasks(TASKS, 'chkout')), ['Flaky e2e test: checkout flow times out'])
})

test('ranks tighter matches first', () => {
  assert.deepEqual(titles(searchTasks(TASKS, 'cache')), [
    'Cache invalidation for product catalog',
    'Spike: evaluate SQLite for the local cache',
  ])
})

test('every word must match somewhere (AND), each in any field', () => {
  assert.deepEqual(titles(searchTasks(TASKS, 'cache perf')), ['Cache invalidation for product catalog'])
  assert.deepEqual(titles(searchTasks(TASKS, 'cache nope')), [])
})

test('still finds words in the body', () => {
  assert.deepEqual(titles(searchTasks(TASKS, 'postgres')), ['Write onboarding guide'])
})

test('one- and two-letter terms ignore the body, where they match nearly any paragraph', () => {
  assert.deepEqual(titles(searchTasks(TASKS, 'up')), [])
  assert.deepEqual(titles(searchTasks(TASKS, 'setup')), ['Write onboarding guide'])
})

test('letters scattered mid-word across a long title are not a match', () => {
  assert.deepEqual(titles(searchTasks(TASKS, 'eai')), [])
  assert.deepEqual(titles(searchTasks(TASKS, 'zq')), [])
})

test('fuzzyMatch reports the positions of the best alignment', () => {
  assert.deepEqual(fuzzyMatch('rtr', 'Refresh Token Rotation')?.positions, [0, 8, 14])
  assert.deepEqual(fuzzyMatch('cache', 'the local cache')?.positions, [10, 11, 12, 13, 14], 'the whole word, not scattered letters')
  assert.equal(fuzzyMatch('zz', 'Refresh'), undefined)
})

test('search hits say which letters matched, per field', () => {
  const [rtr] = searchHits(TASKS, 'rtr')
  assert.deepEqual(rtr.title, [0, 8, 14])
  assert.deepEqual(rtr.tags, {})

  const [tag] = searchHits(TASKS, '#fla')
  assert.deepEqual(tag.title, [], '#term never highlights the title')
  assert.deepEqual(tag.tags, { flaky: [0, 1, 2] })

  const [both] = searchHits(TASKS, 'cache perf')
  assert.deepEqual(both.title, [0, 1, 2, 3, 4])
  assert.deepEqual(both.tags, { perf: [0, 1, 2, 3] })

  const [body] = searchHits(TASKS, 'postgres')
  assert.deepEqual([body.title, body.tags], [[], {}], 'body hits have nothing to show in the list')
})

test('an empty query is the normal sort order', () => {
  assert.deepEqual(searchTasks(TASKS, '  '), sortTasks(TASKS))
})
