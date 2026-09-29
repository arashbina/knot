import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import {
  addTodo, addUpdate, claimTask, createTask, deleteTask, formatId, listClaims, load, loadAll, nextId, NotFoundError, openStore, parseTask, setDir,
  removeTodo, setBody, setStatus, setTags, setTitle, setTodoDetail, setTodoState, setTodoText,
  slugify, yamlScalar, type Store,
} from '../src/index.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function tempStore(): Store {
  return openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'knot-store-')))
}

function write(store: Store, name: string, raw: string) {
  const file = path.join(store.dir, name)
  fs.writeFileSync(file, raw)
  return parseTask(file, raw)
}

/** Lines that differ, ignoring the `updated:` stamp every mutator bumps. */
function changed(before: string, after: string) {
  const strip = (s: string) => s.split('\n').filter((l) => !l.startsWith('updated:'))
  const a = strip(before)
  const b = strip(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  return { removed: a.slice(head, a.length - tail), added: b.slice(head, b.length - tail) }
}

const DOC = `---
id: t-001
title: Sample
status: backlog
tags:
  - infra
  - ci
created: 2026-09-01T10:00:00Z
updated: 2026-09-01T10:00:00Z
---

Body text.

## Todo

- [ ] first
- [ ] second
    detail of second

    more detail
- [ ] third

## Updates

### 2026-09-01 10:00 — human

Initial.
`

test('setTodoState flips exactly one character and bumps updated', () => {
  const store = tempStore()
  const task = write(store, 't-001-sample.md', DOC)
  const next = setTodoState(task, 2, 'done')
  const after = fs.readFileSync(task.file, 'utf8')
  assert.deepEqual(changed(DOC, after), { removed: ['- [ ] second'], added: ['- [x] second'] })
  assert.equal(next.todos[1].state, 'done')
  assert.notEqual(next.updated, task.updated)
})

test('mutators resolve ordinals against the file as it is now, not the stale Task', () => {
  const store = tempStore()
  const stale = write(store, 't-001-sample.md', DOC)
  fs.writeFileSync(stale.file, DOC.replace('Body text.', 'Body text.\n\nAn extra paragraph\nadded in Obsidian.'))
  setTodoState(stale, 1, 'done')
  const fresh = loadAll(store)[0]
  assert.equal(fresh.todos[0].state, 'done')
  assert.match(fresh.body, /added in Obsidian/)
})

test('setTodoText keeps $& literal and leaves the marker alone', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC)
  setTodoText(task, 1, 'costs $& and $1')
  const after = fs.readFileSync(task.file, 'utf8')
  assert.deepEqual(changed(DOC, after), { removed: ['- [ ] first'], added: ['- [ ] costs $& and $1'] })
})

test('removeTodo removes the checkbox and its detail together', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC)
  const next = removeTodo(task, 2)
  assert.deepEqual(next.todos.map((t) => t.text), ['first', 'third'])
  assert.doesNotMatch(fs.readFileSync(task.file, 'utf8'), /detail of second/)
})

test('setTodoDetail replaces, indents past the checkbox, leaves blanks empty, and "" removes', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC)
  let next = setTodoDetail(task, 1, 'line one\n\n- [ ] nested')
  const raw = fs.readFileSync(task.file, 'utf8')
  assert.match(raw, /- \[ \] first\n {4}line one\n\n {4}- \[ \] nested\n- \[ \] second/)
  assert.equal(next.todos.length, 3)
  assert.equal(next.todos[0].detail, 'line one\n\n- [ ] nested')
  next = setTodoDetail(next, 2, '')
  assert.equal(next.todos[1].detail, '')
  assert.equal(next.todos[1].text, 'second')
})

test('setTitle quotes ": " so the YAML survives', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC)
  const next = setTitle(task, 'Parser: handle it')
  assert.equal(next.error, undefined)
  assert.equal(next.title, 'Parser: handle it')
  assert.match(fs.readFileSync(task.file, 'utf8'), /^title: 'Parser: handle it'$/m)
})

test('setTags swallows an Obsidian block list instead of orphaning its items', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC)
  const next = setTags(task, ['#ops', 'ci', 'ops'])
  assert.equal(next.error, undefined)
  assert.deepEqual(next.tags, ['ops', 'ci'])
  assert.doesNotMatch(fs.readFileSync(task.file, 'utf8'), /- infra/)
})

test('setStatus rewrites one line', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC)
  setStatus(task, 'blocked')
  assert.deepEqual(changed(DOC, fs.readFileSync(task.file, 'utf8')), { removed: ['status: backlog'], added: ['status: blocked'] })
})

test('addTodo appends after the last item, past its detail', () => {
  const store = tempStore()
  const raw = DOC.replace('- [ ] third\n', '- [ ] third\n    third detail\n')
  const task = write(store, 'a.md', raw)
  const next = addTodo(task, 'fourth')
  assert.deepEqual(next.todos.map((t) => t.text), ['first', 'second', 'third', 'fourth'])
  assert.equal(next.todos[2].detail, 'third detail')
})

test('addTodo creates ## Todo before ## Updates when absent', () => {
  const store = tempStore()
  const task = write(store, 'a.md', '---\nid: t-1\n---\n\nBody\n\n## Updates\n')
  const next = addTodo(task, 'first')
  assert.equal(next.todos[0].text, 'first')
  assert.match(fs.readFileSync(task.file, 'utf8'), /## Todo\n\n- \[ \] first\n\n## Updates/)
})

test('addUpdate inserts newest first beneath ## Updates', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC)
  const next = addUpdate(task, '  Did the thing.  ', 'agent')
  assert.equal(next.updates.length, 2)
  assert.equal(next.updates[0].author, 'agent')
  assert.equal(next.updates[0].body, 'Did the thing.')
  assert.match(fs.readFileSync(task.file, 'utf8'), /## Updates\n\n### \d{4}-\d\d-\d\d \d\d:\d\d — agent\n\nDid the thing\.\n\n### 2026-09-01/)
})

test('addUpdate keeps a hand-typed undated note as its own entry instead of swallowing it', () => {
  const store = tempStore()
  const task = write(store, 'a.md', '---\nid: t-1\n---\n\n## Updates\n\nBlocked\n')
  const next = addUpdate(task, 'Unblocked now.', 'agent')
  assert.deepEqual(next.updates.map((u) => [u.author, u.body]), [['agent', 'Unblocked now.'], ['human', 'Blocked']])
  assert.equal(next.updates[1].at, 'undated')
  assert.match(fs.readFileSync(task.file, 'utf8'), /\n### undated — human\n\nBlocked\n/, 'the note itself is untouched')
})

test('setBody round-trips with Task.body, including extra ## sections', () => {
  const store = tempStore()
  const raw = DOC.replace('Initial.\n', 'Initial.\n\n## Notes\n\nKeep me once.\n')
  const task = write(store, 'a.md', raw)
  assert.match(task.body, /## Notes/)
  const next = setBody(task, task.body)
  assert.equal(next.body, task.body)
  assert.equal(fs.readFileSync(task.file, 'utf8').match(/Keep me once/g)?.length, 1)
  assert.equal(next.todos.length, 3)
  assert.equal(next.updates.length, 1)
})

test('a mutation that changes nothing does not touch the file', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC)
  setStatus(task, 'backlog')
  assert.equal(fs.readFileSync(task.file, 'utf8'), DOC)
})

test('an unknown ordinal throws "no todo #n on <id>"', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC)
  assert.throws(() => setTodoState(task, 9, 'done'), /no todo #9 on t-001/)
})

test('createTask writes id-slug.md with ordered frontmatter, seeded todos and empty Updates', () => {
  const store = tempStore()
  const task = createTask(store, { title: 'Ship it: v2', tags: ['a', 'b'], body: 'Why.', todos: ['one', 'two'] })
  assert.equal(path.basename(task.file), 't-001-ship-it-v2.md')
  assert.equal(task.status, 'backlog')
  assert.equal(task.title, 'Ship it: v2')
  assert.deepEqual(task.todos.map((t) => t.text), ['one', 'two'])
  const keys = fs.readFileSync(task.file, 'utf8').split('\n').slice(1, 7).map((l) => l.split(':')[0])
  assert.deepEqual(keys, ['id', 'title', 'status', 'tags', 'created', 'updated'])
})

test('setDir adds, replaces and removes the dir line and nothing else', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC)
  let next = setDir(task, '/code/app')
  assert.deepEqual(changed(DOC, fs.readFileSync(task.file, 'utf8')), { removed: [], added: ['dir: /code/app'] })
  assert.equal(next.dir, '/code/app')
  next = setDir(next, '/code/other app')
  assert.equal(next.dir, '/code/other app')
  next = setDir(next, undefined)
  assert.equal(next.dir, undefined)
  assert.deepEqual(changed(DOC, fs.readFileSync(task.file, 'utf8')), { removed: [], added: [] })
})

test('createTask records dir when given', () => {
  const store = tempStore()
  assert.equal(createTask(store, { title: 'x', dir: '/code/app' }).dir, '/code/app')
  assert.equal(createTask(store, { title: 'y' }).dir, undefined)
})

test('createTask writes each todo with its own detail and state', () => {
  const store = tempStore()
  const task = createTask(store, {
    title: 'With context',
    todos: ['plain', { text: 'with detail', detail: 'See src/a.ts:12\n\n- [ ] sub-step' }, { text: 'already done', state: 'done' }],
  })
  assert.deepEqual(task.todos.map((t) => [t.text, t.state, t.detail]), [
    ['plain', 'pending', ''],
    ['with detail', 'pending', 'See src/a.ts:12\n\n- [ ] sub-step'],
    ['already done', 'done', ''],
  ])
})

test('nextId counts broken-frontmatter files by filename and never reuses a lower gap', () => {
  const store = tempStore()
  write(store, 't-001-a.md', '---\nid: t-001\n---\n')
  write(store, 't-004-broken.md', '---\nid: [nope\n---\n')
  assert.equal(nextId(store), 't-005')
})

test('load falls back to the filename prefix for broken frontmatter', () => {
  const store = tempStore()
  write(store, 't-004-broken.md', '---\nid: [nope\n---\n')
  assert.equal(load(store, 't-004')?.error !== undefined, true)
})

test('openStore refuses a missing vault unless asked to create it', () => {
  const dir = path.join(os.tmpdir(), `knot-missing-${process.pid}-${Date.now()}`)
  assert.throws(() => openStore(dir), /vault not found/)
  openStore(dir, { create: true })
  assert.ok(fs.existsSync(dir))
})

test('openStore refuses a vault path that is a file, even when asked to create it', () => {
  const file = path.join(tempStore().dir, 'not-a-dir')
  fs.writeFileSync(file, '')
  for (const opts of [{}, { create: true }])
    assert.throws(() => openStore(file, opts), (e) => e instanceof NotFoundError && /vault is not a directory/.test(e.message))
  assert.equal(fs.readFileSync(file, 'utf8'), '')
})

test('deleteTask unlinks the file', () => {
  const store = tempStore()
  const task = createTask(store, { title: 'x' })
  deleteTask(task)
  assert.equal(loadAll(store).length, 0)
})

test('deleteTask deletes nothing when it cannot retire the id', () => {
  const store = tempStore()
  const task = write(store, 't-001-by-hand.md', '---\nid: t-001\ntitle: By hand\n---\n')
  fs.writeFileSync(path.join(store.dir, '.knot'), '') // a file where the .knot folder belongs
  assert.throws(() => deleteTask(task))
  assert.deepEqual(loadAll(store).map((t) => t.id), ['t-001'])
})

test('yamlScalar quotes anything YAML would reinterpret', () => {
  for (const v of ['a: b', 'x #y', '#tag', '- item', 'true', 'No', '12', '1.5', '0x1F', '1:30', '.inf', '2026-09-25 10:00:00', "it's [x]", ' pad'])
    assert.match(yamlScalar(v), /^'/, v)
  assert.equal(yamlScalar("it's: fine"), "'it''s: fine'")
  assert.equal(yamlScalar('plain title'), 'plain title')
  assert.equal(yamlScalar('two\nlines'), 'two lines')
})

test('slugify lowercases, collapses non-alphanumerics and caps at 48', () => {
  assert.equal(slugify('Refresh token: rotation — breaks!'), 'refresh-token-rotation-breaks')
  assert.equal(slugify('Café'), 'cafe')
  assert.ok(slugify('x'.repeat(80)).length <= 48)
})

test('an empty note (Obsidian\'s new Untitled.md) takes edits like any other', () => {
  const store = tempStore()
  for (const [name, raw] of [['Untitled.md', ''], ['Untitled 1.md', '\n  \n']]) {
    let task = write(store, name, raw)
    task = setStatus(task, 'review')
    task = setTitle(task, 'Real title')
    task = addTodo(task, 'first')
    const onDisk = parseTask(task.file, fs.readFileSync(task.file, 'utf8'))
    assert.deepEqual([onDisk.status, onDisk.title, onDisk.todos.map((t) => t.text)], ['review', 'Real title', ['first']], name)
  }
})

test('a file caught mid-save, truncated but not yet rewritten, is edited once the save lands', async () => {
  const store = tempStore()
  const task = write(store, 't-001-sample.md', DOC)
  const saved = path.join(store.dir, '.saved')
  fs.writeFileSync(saved, DOC)
  fs.writeFileSync(task.file, '')
  const editor = spawn('sh', ['-c', 'sleep 0.03; cat "$0" > "$1"', saved, task.file])
  const exited = new Promise((resolve) => editor.on('exit', resolve))
  const next = setStatus(task, 'review')
  await exited
  assert.equal(next.status, 'review')
  assert.deepEqual(changed(DOC, fs.readFileSync(task.file, 'utf8')), { removed: ['status: backlog'], added: ['status: review'] })
})

test('a mutator refuses a half-written file that no longer reads as the task', () => {
  const store = tempStore()
  const task = write(store, 't-001-sample.md', DOC)
  const partial = DOC.slice(0, 30)
  fs.writeFileSync(task.file, partial)
  assert.throws(() => setTitle(task, 'Renamed'), /no longer reads as t-001/)
  assert.equal(fs.readFileSync(task.file, 'utf8'), partial)
})

test('a read cut inside the frontmatter is refused even when the id falls back to a matching filename', () => {
  const store = tempStore()
  const task = createTask(store, { title: 'Исправить баг', todos: ['one'] })
  assert.equal(path.basename(task.file), 't-001.md')
  const full = fs.readFileSync(task.file, 'utf8')
  for (const cut of [20, 60]) {
    fs.writeFileSync(task.file, full.slice(0, cut))
    assert.throws(() => setStatus(task, 'review'), /mid-save/, `cut at ${cut}`)
    assert.equal(fs.readFileSync(task.file, 'utf8'), full.slice(0, cut))
  }
  // A task that was already broken when loaded still takes edits.
  const broken = write(store, 't-004-broken.md', '---\nid: [nope\n---\n\nBody.\n')
  assert.notEqual(broken.error, undefined)
  assert.equal(setTodoState(addTodo(broken, 'one'), 1, 'done').todos[0].state, 'done')
})

test('writes keep the file mode and leave no temp files in the vault', () => {
  const store = tempStore()
  const task = write(store, 't-001-sample.md', DOC)
  fs.chmodSync(task.file, 0o640)
  setStatus(task, 'review')
  addTodo(task, 'fourth')
  assert.equal(fs.statSync(task.file).mode & 0o777, 0o640)
  assert.deepEqual(fs.readdirSync(store.dir), ['t-001-sample.md'])
})

test('a read-only task file is refused, not replaced', { skip: process.getuid?.() === 0 && 'root writes anyway' }, () => {
  const store = tempStore()
  const task = write(store, 't-001-sample.md', DOC)
  fs.chmodSync(task.file, 0o444)
  assert.throws(() => setStatus(task, 'review'), { code: 'EACCES' })
  assert.equal(fs.readFileSync(task.file, 'utf8'), DOC)
  assert.deepEqual(fs.readdirSync(store.dir), ['t-001-sample.md'])
})

/** Another program saves `file` (as `save(n)`) each of the first `times` times the mutator writes anything. */
function saveDuringWrites(t: TestContext, file: string, save: (n: number) => string, times: number): void {
  const real = fs.writeFileSync
  let n = 0
  const spy = t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof real>) => {
    if (n < times) real(file, save(n++))
    else spy.mock.restore()
    real(...args)
  })
}

test('a change saved while a mutator writes is kept, and the mutation lands on top of it', (t) => {
  const store = tempStore()
  const task = write(store, 't-001-sample.md', DOC)
  const theirs = DOC.replace('- [ ] third', '- [ ] third\n- [ ] added in Obsidian')
  saveDuringWrites(t, task.file, () => theirs, 1)
  const next = setTodoState(task, 1, 'done')
  assert.deepEqual(next.todos.map((x) => [x.text, x.state]), [['first', 'done'], ['second', 'pending'], ['third', 'pending'], ['added in Obsidian', 'pending']])
  assert.deepEqual(changed(theirs, fs.readFileSync(task.file, 'utf8')), { removed: ['- [ ] first'], added: ['- [x] first'] })
  assert.deepEqual(fs.readdirSync(store.dir), ['t-001-sample.md'])
})

test('a file that keeps changing under a mutator is left to the other writer', (t) => {
  const store = tempStore()
  const task = write(store, 't-001-sample.md', DOC)
  let last = DOC
  saveDuringWrites(t, task.file, (n) => (last = DOC.replace('Body text.', `Body text, save ${n}.`)), 100)
  assert.throws(() => setStatus(task, 'review'), /changed while writing; not written/)
  assert.equal(fs.readFileSync(task.file, 'utf8'), last)
  assert.deepEqual(fs.readdirSync(store.dir), ['t-001-sample.md'])
})

test('deleting the highest-numbered task never hands its id out again', () => {
  const store = tempStore()
  createTask(store, { title: 'one' })
  deleteTask(createTask(store, { title: 'two' }))
  assert.equal(createTask(store, { title: 'three' }).id, 't-003')
})

test('a hand-made task deleted through knot retires its id too', () => {
  const store = tempStore()
  deleteTask(write(store, 't-001-by-hand.md', '---\nid: t-001\ntitle: By hand\n---\n'))
  assert.equal(createTask(store, { title: 'next' }).id, 't-002')
})

test('deleteTask drops the task\'s claim', () => {
  const store = tempStore()
  const task = createTask(store, { title: 'claimed' })
  const probe = (pid: number) => (pid === 100 ? 'T0' : undefined)
  assert.ok(claimTask(store, task.id, { session: { session: 'session-a', pid: 100, started: 'T0', host: os.hostname() }, probe }).ok)
  deleteTask(task)
  assert.deepEqual(listClaims(store, probe), [])
})

test('concurrent creates never share an id', async () => {
  const store = tempStore()
  // A bigger vault widens the gap between scanning for the next id and writing the file.
  for (let n = 1; n <= 100; n++) fs.writeFileSync(path.join(store.dir, `${formatId(n)}-x.md`), `---\nid: ${formatId(n)}\ntitle: x\n---\n`)
  const start = Date.now() + 800
  const create = (i: number) => new Promise<string>((resolve, reject) => {
    const script = [
      `import { createTask, openStore } from ${JSON.stringify(path.join(ROOT, 'packages/core/src/index.ts'))}`,
      `while (Date.now() < ${start});`,
      `process.stdout.write(createTask(openStore(${JSON.stringify(store.dir)}), { title: 'Racer ${i}' }).id)`,
    ].join('\n')
    execFile(path.join(ROOT, 'node_modules/.bin/tsx'), ['-e', script], (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
  const ids = await Promise.all([1, 2, 3, 4, 5, 6].map(create))
  assert.equal(new Set(ids).size, 6, ids.join(' '))
  const onDisk = loadAll(store).filter((t) => t.title.startsWith('Racer')).map((t) => t.id)
  assert.deepEqual(onDisk.sort(), [...ids].sort())
})

/** addUpdate added exactly one entry, `author`'s, and left everything else as it was. */
function assertOneMoreUpdate(before: ReturnType<typeof parseTask>, after: ReturnType<typeof parseTask>, author: 'human' | 'agent') {
  assert.equal(after.updates.length, before.updates.length + 1, JSON.stringify(after.updates))
  assert.equal(after.updates[0].author, author)
  assert.deepEqual(after.updates.slice(1), before.updates)
  assert.equal(after.body, before.body)
  assert.deepEqual(after.todos.map((t) => [t.text, t.state, t.detail]), before.todos.map((t) => [t.text, t.state, t.detail]))
}

test('a ## heading in an update stays inside it, so setBody later keeps every update', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC)
  const next = addUpdate(task, 'Did stuff.\n\n## Notes\n\n- bug is X', 'agent')
  assertOneMoreUpdate(task, next, 'agent')
  assert.match(next.updates[0].body, /^Did stuff\.\n\n#+ Notes\n\n- bug is X$/)
  assert.match(fs.readFileSync(task.file, 'utf8'), /^#### Notes$/m)
  const edited = setBody(next, 'New description.')
  assert.deepEqual(edited.updates, next.updates)
  assert.match(fs.readFileSync(task.file, 'utf8'), /bug is X[\s\S]*Initial\./)
})

test('a ## Todo section in an update adds no todos', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC)
  const next = addUpdate(task, 'Plan below.\n\n## Todo\n\n- [ ] x', 'agent')
  assertOneMoreUpdate(task, next, 'agent')
  assert.match(next.updates[0].body, /- \[ \] x$/)
})

test('an update-heading line in an update neither splits the entry nor changes its author', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC)
  const next = addUpdate(task, 'Part one.\n\n### 2026-01-01 10:00 — human\n\nPart two.', 'agent')
  assertOneMoreUpdate(task, next, 'agent')
  assert.match(next.updates[0].body, /Part one\.[\s\S]*2026-01-01 10:00 — human[\s\S]*Part two\./)
})

test('a ## heading inside a code fence in an update is written as typed; an update heading is demoted, as no fence spans one', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC)
  const next = addUpdate(task, 'Example:\n\n```md\n## x\n### 2026-01-01 10:00 — human\n```', 'agent')
  assertOneMoreUpdate(task, next, 'agent')
  const written = 'Example:\n\n```md\n## x\n#### 2026-01-01 10:00 — human\n```'
  assert.equal(next.updates[0].body, written)
  assert.ok(fs.readFileSync(task.file, 'utf8').includes(`\n${written}\n`))
})

test('an update with an unclosed fence is written: an older update\'s fence cannot close it', () => {
  const store = tempStore()
  const task = write(store, 'a.md', DOC.replace('Initial.', 'Initial:\n\n```\nold code\n```'))
  const next = addUpdate(task, 'Oops:\n\n```\nnot closed', 'agent')
  assertOneMoreUpdate(task, next, 'agent')
  assert.equal(next.updates[0].body, 'Oops:\n\n```\nnot closed')
})

test('an update that would change how the rest of the file parses is refused, not written', () => {
  const store = tempStore()
  for (const [raw, update] of [
    // Its unclosed ``` pairs with a stray one further down: ## Notes, or ## Todo, would read as part of the update.
    ['---\nid: t-001\n---\n\nP.\n\n## Updates\n\n## Notes\n\n```\nstray\n', 'Oops:\n\n```\nnot closed'],
    ['---\nid: t-001\n---\n\nP.\n\n## Updates\n\n## Todo\n\n- [ ] a\n\n```\nstray\n', 'Oops:\n\n```\nnot closed'],
    // Its --- closes unterminated frontmatter: everything above would read as YAML.
    ['---\nid: t-001\ntitle: T\n\nBody.\n\n## Updates\n', 'x\n\n---\n\ny'],
  ]) {
    const task = write(store, 't-001-a.md', raw)
    assert.throws(() => addUpdate(task, update, 'agent'), /would change the task's todos, updates or body beyond the edit; not written/, raw)
    assert.equal(fs.readFileSync(task.file, 'utf8'), raw)
  }
})

// A ``` indented under a todo is its detail, and still closes a fence opened above ## Todo.
const FENCED_DETAIL = DOC.replace('- [ ] third', '- [ ] third\n  ```\n  code\n  ```')

test('setBody refuses a body whose unclosed fence would hide the todos below it', () => {
  const store = tempStore()
  const task = write(store, 'a.md', FENCED_DETAIL)
  assert.throws(() => setBody(task, 'New:\n\n```\nunclosed'), /would change the task's todos, updates or body beyond the edit; not written/)
  assert.equal(fs.readFileSync(task.file, 'utf8'), FENCED_DETAIL)
})

test('setBody refuses a file whose ## Todo a stray fence already hides, rather than delete the todos with the body', () => {
  const store = tempStore()
  const raw = FENCED_DETAIL.replace('Body text.', 'Body text.\n\n```\nstray')
  const task = write(store, 'a.md', raw)
  assert.equal(task.todos.length, 0)
  assert.throws(() => setBody(task, 'Fixed.'), /fence hides its ## Todo/)
  assert.equal(fs.readFileSync(task.file, 'utf8'), raw)
})

test('deleteTask removes a hand-made note whose long non-ASCII name is its id', () => {
  const store = tempStore()
  const note = write(store, 'Отчёт о переговорах с поставщиками по новому контракту.md', 'Just notes.\n')
  deleteTask(note)
  assert.equal(fs.existsSync(note.file), false)
})

test('a stale task whose file was emptied, and stays empty, is refused rather than rewritten as a stub', () => {
  const store = tempStore()
  const task = write(store, 't-001-sample.md', DOC)
  fs.writeFileSync(task.file, '')
  assert.throws(() => setStatus(task, 'review'), /no longer reads as t-001/)
  assert.equal(fs.readFileSync(task.file, 'utf8'), '')
})

test('setBody never writes a body its next call would refuse, and says which heading a fence hides', () => {
  const store = tempStore()
  const note = write(store, 'Meeting notes.md', 'Just a note.\n')
  assert.throws(() => setBody(note, 'How to write a task:\n\n```md\n## Todo\n\n- [ ] first\n```'), /fence hides its ## Todo heading \(line \d+\)/)
  assert.equal(fs.readFileSync(note.file, 'utf8'), 'Just a note.\n')
})
