import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fencedLines, parseStatus, parseTask, scanSections, splitLines } from '../src/index.js'

const SAMPLE = `---
id: t-001
title: Refresh token rotation breaks under concurrent requests
status: in-progress          # backlog todo in-progress blocked review done
tags: [auth, bug, p1]
created: 2026-09-14T09:12:00Z
updated: 2026-09-23T16:40:00Z
---

Rich markdown body.

## Todo

- [x] done one
- [/] Wire up chokidar and debounce rapid writes
    Debounce at 80ms — a single save fires several events.

    - [ ] a checklist here stays in the detail
- [ ] pending one
- [-] cancelled one

## Updates

### 2026-09-23 16:40 — agent

Newest first.

### 2026-09-22 10:00 — human

Older.
`

test('reads frontmatter and coerces unquoted timestamps to ISO strings', () => {
  const t = parseTask('/v/t-001-x.md', SAMPLE)
  assert.equal(t.id, 't-001')
  assert.equal(t.status, 'in-progress')
  assert.deepEqual(t.tags, ['auth', 'bug', 'p1'])
  assert.equal(t.created, '2026-09-14T09:12:00.000Z')
  assert.equal(t.updated, '2026-09-23T16:40:00.000Z')
  assert.equal(t.body, 'Rich markdown body.')
  assert.equal(t.error, undefined)
})

test('todos carry absolute line numbers, state and a block end that spans the detail', () => {
  const t = parseTask('/v/a.md', SAMPLE)
  const lines = SAMPLE.split('\n')
  assert.deepEqual(t.todos.map((x) => x.state), ['done', 'in-progress', 'pending', 'cancelled'])
  assert.deepEqual(t.todos.map((x) => x.ordinal), [1, 2, 3, 4])
  const wire = t.todos[1]
  assert.match(lines[wire.line], /Wire up chokidar/)
  assert.match(lines[wire.endLine - 1], /a checklist here/)
  assert.equal(wire.detail, 'Debounce at 80ms — a single save fires several events.\n\n- [ ] a checklist here stays in the detail')
  assert.equal(t.todos[0].detail, '')
  assert.equal(t.todos[0].endLine, t.todos[0].line + 1)
})

test('updates parse newest first with author and stamp', () => {
  const t = parseTask('/v/a.md', SAMPLE)
  assert.deepEqual(t.updates, [
    { at: '2026-09-23 16:40', author: 'agent', body: 'Newest first.' },
    { at: '2026-09-22 10:00', author: 'human', body: 'Older.' },
  ])
})

test('section headings match case-insensitively; other ## headings are body', () => {
  const raw = '---\nid: t-2\n---\nIntro\n\n## Context\n\nWhy.\n\n## TODO\n\n- [ ] a\n\n## notes\n\nLater.\n'
  const t = parseTask('/v/a.md', raw)
  assert.equal(t.todos.length, 1)
  assert.equal(t.body, 'Intro\n\n## Context\n\nWhy.\n\n## notes\n\nLater.')
})

test('an indented ## heading inside a todo detail stays in the detail', () => {
  const raw = '## Todo\n\n- [ ] spec\n    ## On-disk format\n\n    text\n- [ ] next\n'
  const t = parseTask('/v/a.md', raw)
  assert.equal(t.todos.length, 2)
  assert.equal(t.todos[0].detail, '## On-disk format\n\ntext')
})

test('broken YAML never throws: error set, id and title from the filename, todos still parsed', () => {
  const raw = '---\nid: t-9\ntitle: [unclosed\n---\n\n## Todo\n\n- [ ] still here\n'
  const t = parseTask('/v/t-009-broken.md', raw)
  assert.ok(t.error)
  assert.equal(t.id, 't-009-broken')
  assert.equal(t.title, 't-009-broken')
  assert.equal(t.todos[0].text, 'still here')
})

test('broken YAML is reported every time the same text is parsed, not just the first', () => {
  const raw = '---\nid: [again\n---\n'
  assert.ok(parseTask('/v/a.md', raw).error)
  assert.ok(parseTask('/v/a.md', raw).error)
})

test('unterminated frontmatter is reported, not thrown', () => {
  const t = parseTask('/v/x.md', '---\nid: t-1\n')
  assert.equal(t.error, 'unterminated frontmatter')
})

test('coercions: unknown status → backlog, string tags split, updated falls back to created', () => {
  const raw = '---\nstatus: someday\ntags: a, b ,c\ncreated: 2026-01-01T00:00:00Z\n---\n'
  const t = parseTask('/v/t-5-x.md', raw)
  assert.equal(t.status, 'backlog')
  assert.deepEqual(t.tags, ['a', 'b', 'c'])
  assert.equal(t.updated, t.created)
})

test('parseStatus takes a name, the wip/block aliases, or an unambiguous prefix', () => {
  assert.equal(parseStatus('review'), 'review')
  assert.equal(parseStatus('WIP'), 'in-progress')
  assert.equal(parseStatus('block'), 'blocked')
  assert.equal(parseStatus('rev'), 'review')
  assert.equal(parseStatus('bl'), 'blocked')
  assert.equal(parseStatus('b'), undefined, 'backlog or blocked')
  assert.equal(parseStatus('todo'), undefined, 'not a status any more')
})

test('frontmatter status accepts the wip alias; an old `todo` reads as backlog', () => {
  assert.equal(parseTask('/v/a.md', '---\nstatus: wip\n---\n').status, 'in-progress')
  assert.equal(parseTask('/v/a.md', '---\nstatus: todo\n---\n').status, 'backlog')
})

test('dir is the optional project directory from frontmatter', () => {
  assert.equal(parseTask('/v/a.md', '---\ndir: ~/code/app\n---\n').dir, '~/code/app')
  assert.equal(parseTask('/v/a.md', '---\nid: t-1\n---\n').dir, undefined)
})

test("Obsidian's indented block-list tags parse", () => {
  const t = parseTask('/v/a.md', '---\ntags:\n  - infra\n  - ci\n---\n')
  assert.deepEqual(t.tags, ['infra', 'ci'])
})

test('unknown marker parses as pending; uppercase X is done', () => {
  const t = parseTask('/v/a.md', '## Todo\n- [?] odd\n- [X] upper\n')
  assert.deepEqual(t.todos.map((x) => x.state), ['pending', 'done'])
})

test('tab-indented detail belongs to its checkbox', () => {
  const t = parseTask('/v/a.md', '## Todo\n- [ ] a\n\tdetail line\n\t- [ ] nested\n- [ ] b\n')
  assert.equal(t.todos.length, 2)
  assert.equal(t.todos[0].detail, 'detail line\n- [ ] nested')
})

test('CRLF files parse the same as LF', () => {
  const t = parseTask('/v/a.md', '---\r\nid: t-1\r\n---\r\n## Todo\r\n- [x] a\r\n')
  assert.equal(t.id, 't-1')
  assert.equal(t.todos[0].state, 'done')
  assert.equal(t.todos[0].text, 'a')
})

test('a note typed under ## Updates without a heading is an undated entry by a human, newest first', () => {
  const t = parseTask('/v/a.md', '## Updates\n\nBlocked on DBA review.\n\n### Friday\n\nstill\n\n### 2026-01-01 10:00 - human\n\nbody\n')
  assert.deepEqual(t.updates, [
    { at: '', author: 'human', body: 'Blocked on DBA review.\n\n### Friday\n\nstill' },
    { at: '2026-01-01 10:00', author: 'human', body: 'body' },
  ])
})

test('an Updates section with only blank lines has no entries', () => {
  assert.deepEqual(parseTask('/v/a.md', '## Updates\n\n\n').updates, [])
})

test('frontmatter in a language other than YAML is never evaluated: the file has no frontmatter, and says so', () => {
  const g = globalThis as { __knotEval?: string }
  for (const open of ['---js', '---javascript', '--- JS', '---JavaScript', '\uFEFF---js']) {
    for (const eol of ['\n', '\r\n']) {
      const raw = `${open}${eol}{ id: (globalThis.__knotEval = ${JSON.stringify(open)}, 't-9') }${eol}---${eol}body${eol}`
      const t = parseTask('/v/t-009-evil.md', raw)
      assert.equal(g.__knotEval, undefined, `${JSON.stringify(open)} frontmatter was evaluated`)
      assert.equal(t.id, 't-009-evil')
      assert.match(t.error ?? '', /bare ---/)
    }
  }
})

test('a ---yaml opener is flagged: the id, title and status that fall back to the filename say why', () => {
  for (const open of ['---yaml', '--- yaml', '---json']) {
    const t = parseTask('/v/t-005-real.md', `${open}\nid: t-005\ntitle: Real title\nstatus: in-progress\n---\n\n## Todo\n\n- [ ] a\n`)
    assert.equal(t.id, 't-005-real')
    assert.equal(t.title, 't-005-real')
    assert.match(t.error ?? '', /bare ---/, open)
    assert.deepEqual(t.todos.map((x) => x.text), ['a'])
  }
})

test('a ---- rule on the first line is body, not a frontmatter error', () => {
  const t = parseTask('/v/a.md', '----\n\nProse.\n')
  assert.equal(t.error, undefined)
  assert.equal(t.body, '----\n\nProse.')
})

test('a ---javascript block that would write a file when evaluated writes nothing', () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'knot-parse-')), 'pwned')
  const raw = `---javascript\n{ title: String(require('fs').writeFileSync(${JSON.stringify(marker)}, 'x') || 'owned') }\n---\n`
  const t = parseTask('/v/t-007-evil.md', raw)
  assert.equal(fs.existsSync(marker), false)
  assert.equal(t.title, 't-007-evil')
})

test('YAML frontmatter still parses behind a BOM, with trailing spaces on its opening fence and CRLF', () => {
  const t = parseTask('/v/a.md', "\uFEFF---  \r\nid: t-4\r\ntitle: 'a: b'\r\n---\r\nbody\r\n")
  assert.equal(t.id, 't-4')
  assert.equal(t.title, 'a: b')
  assert.equal(t.body, 'body')
  assert.equal(t.error, undefined)
})

const FENCED_BODY = `---
id: t-3
---
A task file looks like:

\`\`\`md
## Todo

- [ ] example
## Updates

example note
\`\`\`

More prose.

## Todo

- [ ] real one
- [x] real two

## Updates

### 2026-09-23 16:40 — agent

Real update.
`

test('a fenced ## Todo / ## Updates example is body: the fence stays whole, todos and updates are only the real ones', () => {
  const t = parseTask('/v/a.md', FENCED_BODY)
  assert.equal(t.body, 'A task file looks like:\n\n```md\n## Todo\n\n- [ ] example\n## Updates\n\nexample note\n```\n\nMore prose.')
  assert.deepEqual(t.todos.map((x) => [x.ordinal, x.text]), [[1, 'real one'], [2, 'real two']])
  assert.deepEqual(t.updates, [{ at: '2026-09-23 16:40', author: 'agent', body: 'Real update.' }])
})

test('stdin with a fenced ## Todo / ## Updates example has no sections, so knot new keeps it all as body', () => {
  const stdin = 'Format example:\n\n```md\n## Todo\n\n- [ ] example item\n## Updates\n```\n\nAfter fence.\n'
  assert.deepEqual(scanSections(splitLines(stdin)).map((s) => s.kind), ['body'])
  const t = parseTask('stdin.md', stdin)
  assert.equal(t.body, stdin.trim())
  assert.deepEqual(t.todos, [])
})

test('a checkbox in a fence under ## Todo is not a todo and takes no ordinal', () => {
  const t = parseTask('/v/a.md', '## Todo\n\n- [ ] real one\n\n```md\n- [ ] example\n```\n\n- [ ] real two\n')
  assert.deepEqual(t.todos.map((x) => [x.ordinal, x.text]), [[1, 'real one'], [2, 'real two']])
})

test('a tilde fence closes only on a tilde run at least as long', () => {
  const raw = '~~~~\n## Todo\n```\n- [ ] fake\n~~~\n~~~~\n\n## Todo\n\n- [ ] real\n'
  const t = parseTask('/v/a.md', raw)
  assert.deepEqual(t.todos.map((x) => x.text), ['real'])
  assert.equal(t.body, '~~~~\n## Todo\n```\n- [ ] fake\n~~~\n~~~~')
})

test('a fenced ## heading inside an update stays part of that update', () => {
  const raw = [
    '## Updates', '',
    '### 2026-09-24 10:00 — agent', '',
    'Proposed layout:', '', '```md', '## Notes', '', 'free text', '```', '', 'That is all.', '',
    '### 2026-09-23 10:00 — agent', '', 'Older.', '',
  ].join('\n')
  const t = parseTask('/v/a.md', raw)
  assert.equal(t.body, '')
  assert.deepEqual(t.updates, [
    { at: '2026-09-24 10:00', author: 'agent', body: 'Proposed layout:\n\n```md\n## Notes\n\nfree text\n```\n\nThat is all.' },
    { at: '2026-09-23 10:00', author: 'agent', body: 'Older.' },
  ])
})

test('an update heading starts an entry even inside a fence: no fence spans one', () => {
  const raw = '## Updates\n\n### 2026-09-24 10:00 — agent\n\nThe format:\n\n```\n### 2026-01-01 00:00 — agent\n\nbody\n```\n'
  assert.deepEqual(parseTask('/v/a.md', raw).updates, [
    { at: '2026-09-24 10:00', author: 'agent', body: 'The format:\n\n```' },
    { at: '2026-01-01 00:00', author: 'agent', body: 'body\n```' },
  ])
})

const marks = (text: string, from?: number) => fencedLines(text.split('\n'), from).map((f) => (f ? 1 : 0)).join('')

test('fencedLines marks closed fences, delimiters included, by CommonMark opener and closer rules', () => {
  assert.equal(marks('a\n```ts\nx\n```\nb'), '01110')
  assert.equal(marks('```\nx\n`````'), '111', 'a longer run closes')
  assert.equal(marks('````\n```\n````'), '111', 'a shorter run does not')
  assert.equal(marks('```\n~~~\n```'), '111', 'nor does the other character')
  assert.equal(marks('```\n``` x\n```'), '111', 'nor a run with text after it')
  assert.equal(marks('   ```\nx\n   ```  '), '111', 'up to 3 spaces of indent')
  assert.equal(marks('    ```\nx\n    ```'), '000', '4 spaces is indented code')
  assert.equal(marks('\t```\nx\n\t```'), '000', 'a tab is 4 columns')
  assert.equal(marks('```a`b\nx\n```'), '000', 'a backtick info string holds no backtick')
  assert.equal(marks('~~~a`b\nx\n~~~'), '111', 'a tilde one may')
  assert.equal(marks('```\nx'), '00', 'unclosed')
  assert.equal(marks('```\nx\n```\n```', 1), '0011', 'lines before `from` are skipped')
})

test('an unclosed fence is not a fence: the sections after it still parse', () => {
  const raw = 'Intro\n\n```md\nstray\n\n## Todo\n\n- [ ] a\n\n## Updates\n\n### 2026-01-01 10:00 — agent\n\nx\n'
  const t = parseTask('/v/a.md', raw)
  assert.equal(t.body, 'Intro\n\n```md\nstray')
  assert.deepEqual(t.todos.map((x) => x.text), ['a'])
  assert.deepEqual(t.updates, [{ at: '2026-01-01 10:00', author: 'agent', body: 'x' }])
})

test('fencedLines: an opener closed only beyond an update heading is unclosed', () => {
  const h = '### 2026-01-01 10:00 — agent'
  assert.equal(marks(`\`\`\`\nx\n${h}\n\`\`\``), '0000')
  assert.equal(marks(`\`\`\`\nx\n\`\`\`\n${h}\n\`\`\`\ny\n\`\`\``), '1110111', 'a fence on either side still closes')
  assert.equal(marks(`~~~\n${h}\n~~~\n~~~`), '0011', 'the closer beyond the heading opens a fence of its own')
})

test('an unclosed fence in the body cannot pair with a fence in an update: every todo and update still parses', () => {
  const raw = [
    '---', 'id: t-001', '---', '',
    'Intro. Example:', '', '```js', 'const x = 1', '',
    '## Todo', '', '- [ ] one', '- [ ] two', '',
    '## Updates', '',
    '### 2026-09-24 10:00 — agent', '', 'older plain update', '',
    '### 2026-09-23 10:00 — agent', '', 'Ran it:', '', '```sh', 'npm test', '```', '', 'All green.', '',
  ].join('\n')
  const t = parseTask('/v/a.md', raw)
  assert.equal(t.body, 'Intro. Example:\n\n```js\nconst x = 1')
  assert.deepEqual(t.todos.map((x) => x.text), ['one', 'two'])
  assert.deepEqual(t.updates.map((u) => u.body), ['older plain update', 'Ran it:\n\n```sh\nnpm test\n```\n\nAll green.'])
})

test('an unclosed fence in an update cannot pair with one in an older update', () => {
  const raw = '## Updates\n\n### 2026-09-24 10:00 — agent\n\nOops:\n\n```\nnot closed\n\n### 2026-09-23 10:00 — agent\n\nSee:\n\n```sh\nold\n```\n'
  assert.deepEqual(parseTask('/v/a.md', raw).updates, [
    { at: '2026-09-24 10:00', author: 'agent', body: 'Oops:\n\n```\nnot closed' },
    { at: '2026-09-23 10:00', author: 'agent', body: 'See:\n\n```sh\nold\n```' },
  ])
})
