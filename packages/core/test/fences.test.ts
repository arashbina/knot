import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { addTodo, addUpdate, createTask, openStore, parseTask, setBody, setTodoState, type Task } from '../src/index.js'

const EXAMPLE = ['```md', '## Todo', '', '- [ ] example', '', '## Updates', '', 'example note', '```'].join('\n')

const DOC = [
  '---', 'id: t-001', 'title: Fences', 'status: backlog', '---', '',
  'A task file looks like:', '',
  EXAMPLE, '',
  'More prose.', '',
  '## Todo', '', '- [ ] real one', '',
  '## Updates', '',
  '### 2026-09-23 16:40 — agent', '', 'Real update.', '',
].join('\n')

const BODY = `A task file looks like:\n\n${EXAMPLE}\n\nMore prose.`

function task(raw: string): Task {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'knot-fences-')), 't-001-fences.md')
  fs.writeFileSync(file, raw)
  return parseTask(file, raw)
}

const onDisk = (t: Task) => fs.readFileSync(t.file, 'utf8')

test('addTodo appends to the real Todo section, not a fenced example', () => {
  const t = addTodo(task(DOC), 'real two')
  assert.ok(onDisk(t).includes(EXAMPLE), 'the fenced example is untouched')
  assert.match(onDisk(t), /- \[ \] real one\n- \[ \] real two\n/)
  assert.deepEqual(t.todos.map((x) => [x.ordinal, x.text]), [[1, 'real one'], [2, 'real two']])
  assert.equal(t.body, BODY)
})

test('todo ordinals skip a fenced checkbox, so #1 is the first real todo', () => {
  const t = setTodoState(task(DOC), 1, 'done')
  assert.ok(onDisk(t).includes(EXAMPLE), 'the fenced example is untouched')
  assert.match(onDisk(t), /- \[x\] real one/)
})

test('addUpdate goes to the real Updates section, not a fenced example', () => {
  const t = addUpdate(task(DOC), 'progress', 'agent')
  assert.ok(onDisk(t).includes(EXAMPLE), 'the fenced example is untouched')
  assert.deepEqual(t.updates.map((u) => [u.author, u.body]), [['agent', 'progress'], ['agent', 'Real update.']])
  assert.equal(t.body, BODY)
})

test('setBody replaces a fenced example whole, leaving no stray fence behind', () => {
  const t = setBody(task(DOC), 'Rewritten.')
  assert.equal(onDisk(t).includes('```'), false)
  assert.equal(t.body, 'Rewritten.')
  assert.deepEqual(t.todos.map((x) => x.text), ['real one'])
  assert.deepEqual(t.updates.map((u) => u.body), ['Real update.'])
})

test('setBody keeps every update when one of them holds a fenced ## heading', () => {
  const raw = [
    '---', 'id: t-001', '---', '', 'Old prose.', '',
    '## Todo', '', '- [ ] one', '',
    '## Updates', '',
    '### 2026-09-24 10:00 — agent', '', 'Proposed layout:', '', '```md', '## Notes', '', 'free text', '```', '', 'That is all.', '',
    '### 2026-09-23 10:00 — agent', '', 'Older.', '',
  ].join('\n')
  const t = setBody(task(raw), 'Replaced prose')
  assert.equal(t.body, 'Replaced prose')
  assert.deepEqual(t.updates, [
    { at: '2026-09-24 10:00', author: 'agent', body: 'Proposed layout:\n\n```md\n## Notes\n\nfree text\n```\n\nThat is all.' },
    { at: '2026-09-23 10:00', author: 'agent', body: 'Older.' },
  ])
})

test('a body with an unclosed fence hides no todo or update, so the next setBody keeps them all', () => {
  const store = openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'knot-fences-')))
  let t = createTask(store, { title: 'Loss', todos: ['one', 'two'] })
  t = addUpdate(t, 'Ran it:\n\n```sh\nnpm test\n```\n\nAll green.', 'agent')
  t = addUpdate(t, 'older plain update', 'agent')
  const updates = ['older plain update', 'Ran it:\n\n```sh\nnpm test\n```\n\nAll green.']
  const stray = setBody(t, 'Intro. Example:\n\n```js\nconst x = 1')
  assert.equal(stray.body, 'Intro. Example:\n\n```js\nconst x = 1')
  assert.deepEqual(stray.todos.map((x) => x.text), ['one', 'two'])
  assert.deepEqual(stray.updates.map((u) => u.body), updates)
  const fixed = setBody(stray, 'Intro fixed.')
  assert.equal(fixed.body, 'Intro fixed.')
  assert.deepEqual(fixed.todos.map((x) => x.text), ['one', 'two'])
  assert.deepEqual(fixed.updates.map((u) => u.body), updates)
  assert.match(onDisk(fixed), /## Todo[\s\S]*- \[ \] two[\s\S]*## Updates[\s\S]*npm test/)
})

test('an update with a fenced block is written under a body with a stray fence, and hides nothing', () => {
  const raw = DOC.replace('More prose.', 'More prose.\n\n```\nstray')
  const t = addUpdate(task(raw), 'See:\n\n```\ncode\n```', 'agent')
  assert.equal(t.body, `${BODY}\n\n\`\`\`\nstray`)
  assert.deepEqual(t.todos.map((x) => x.text), ['real one'])
  assert.deepEqual(t.updates.map((u) => u.body), ['See:\n\n```\ncode\n```', 'Real update.'])
})
