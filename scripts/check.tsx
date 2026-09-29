/**
 * Behaviour checks for the TUI's mutating keys: press a key, read the file back,
 * assert the exact line changed and nothing else did. This is the regression net
 * for the line-surgical design.
 *
 * Always runs against a generated two-task fixture in a temp dir, never tasks/:
 * a live session edits the real vault, which bumps `updated`, which re-sorts the
 * list, which moves the cursor's starting task.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import os from 'node:os'
import { claimTask, openStore, parseTask, processStart } from '@knot-tui/core'
import { coloredRuns, startHarness, stripAnsi, tempDir, unpaintedText } from './harness.js'
import { strWidth } from '../packages/tui/src/text.js'
import { theme } from '../packages/tui/src/theme.js'

const ALPHA_FILE = 't-001-alpha-task.md'
const BETA_FILE = 't-002-beta-task.md'

const ALPHA = `---
id: t-001
title: Alpha task
status: in-progress
tags: [one]
created: 2026-09-01T10:00:00Z
updated: 2026-09-20T10:00:00Z
---

Alpha body.

## Todo

- [ ] first todo
- [/] second todo
    second detail line
- [x] third todo

## Updates

### 2026-09-20 10:00 — human

Started.
`

const BETA = `---
id: t-002
title: Beta task
status: backlog
tags: [two]
created: 2026-09-01T10:00:00Z
updated: 2026-09-10T10:00:00Z
---

Beta body.

## Todo

- [ ] beta todo

## Updates
`

/** Only used by the hide-done checks; the two-task fixture above has nothing done. */
const GAMMA = {
  't-003-gamma-shipped.md': `---
id: t-003
title: Gamma shipped
status: done
tags: [three]
created: 2026-09-01T10:00:00Z
updated: 2026-09-05T10:00:00Z
---

## Todo

- [x] shipped

## Updates
`,
}

const COLS = 110
const ROWS = 30

async function setup(t: { after(fn: () => void): void }, extra: Record<string, string> = {}, config?: string) {
  const dir = tempDir('knot-check-')
  fs.writeFileSync(path.join(dir, ALPHA_FILE), ALPHA)
  fs.writeFileSync(path.join(dir, BETA_FILE), BETA)
  for (const [name, raw] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), raw)
  let configFile: string | undefined
  if (config !== undefined) {
    configFile = path.join(tempDir('knot-check-config-'), 'config.toml')
    fs.writeFileSync(configFile, config)
  }
  const h = await startHarness({ dir, cols: COLS, rows: ROWS, configFile })
  t.after(() => h.unmount())
  const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8')
  return { dir, h, read }
}

/** Changed lines, ignoring the `updated:` stamp every write bumps. */
function diff(before: string, after: string) {
  const strip = (s: string) => s.split('\n').filter((l) => !l.startsWith('updated:'))
  const a = strip(before)
  const b = strip(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  return { removed: a.slice(head, a.length - tail), added: b.slice(head, b.length - tail) }
}

const updatedLine = (s: string) => s.split('\n').find((l) => l.startsWith('updated:'))

function assertOnly(before: string, after: string, removed: string[], added: string[]) {
  assert.deepEqual(diff(before, after), { removed, added })
  assert.notEqual(updatedLine(after), updatedLine(before), '`updated` is bumped')
}

test('the initial cursor is on the first task in sort order', async (t) => {
  const { h } = await setup(t)
  assert.match(h.text(), /▌Alpha task/)
})

test('x toggles done on the todo under the cursor — one line, then back', async (t) => {
  const { h, read } = await setup(t)
  await h.press('x')
  assertOnly(ALPHA, read(ALPHA_FILE), ['- [ ] first todo'], ['- [x] first todo'])
  await h.press('x')
  assert.deepEqual(diff(ALPHA, read(ALPHA_FILE)), { removed: [], added: [] })
})

test('space toggles in-progress', async (t) => {
  const { h, read } = await setup(t)
  await h.press('space')
  assertOnly(ALPHA, read(ALPHA_FILE), ['- [ ] first todo'], ['- [/] first todo'])
})

test('J moves the todo cursor from the list pane; x then acts on it', async (t) => {
  const { h, read } = await setup(t)
  await h.press('J', 'x')
  assertOnly(ALPHA, read(ALPHA_FILE), ['- [/] second todo'], ['- [x] second todo'])
  assert.match(h.text(), /▌Alpha task/, 'focus stayed on the list')
})

test('o appends a todo after the last item', async (t) => {
  const { h, read } = await setup(t)
  await h.press('o')
  await h.type('new item')
  await h.press('enter')
  assertOnly(ALPHA, read(ALPHA_FILE), [], ['- [ ] new item'])
})

test('o with an empty commit, or esc, writes nothing', async (t) => {
  const { h, read } = await setup(t)
  await h.press('o', 'enter')
  await h.press('o')
  await h.type('abandoned')
  await h.press('esc')
  assert.equal(read(ALPHA_FILE), ALPHA)
})

test('dd removes the todo and its detail together', async (t) => {
  const { h, read } = await setup(t)
  await h.press('J', 'd', 'd')
  assertOnly(ALPHA, read(ALPHA_FILE), ['- [/] second todo', '    second detail line'], [])
})

test('a write against a file changed underneath fails, says why, and the list catches up with the disk', async (t) => {
  const { h, read, dir } = await setup(t)
  await h.press('J', 'J')
  const edited = ALPHA.replace('- [x] third todo\n', '')
  fs.writeFileSync(path.join(dir, ALPHA_FILE), edited)
  await h.press('x')
  assert.match(h.text(), /done: no todo #3 on t-001/)
  assert.equal(read(ALPHA_FILE), edited, 'nothing written')
  assert.doesNotMatch(h.text(), /third todo/, 'the list re-read the file')
})

test('n creates a task, pulls trailing #tags, and selects it', async (t) => {
  const { h, read, dir } = await setup(t)
  await h.press('n')
  await h.type('Gamma task #g1')
  await h.press('enter')
  const file = path.join(dir, 't-003-gamma-task.md')
  assert.ok(fs.existsSync(file), 'new file written')
  const created = parseTask(file, fs.readFileSync(file, 'utf8'))
  assert.equal(created.title, 'Gamma task')
  assert.deepEqual(created.tags, ['g1'])
  assert.equal(read(ALPHA_FILE), ALPHA)
  assert.equal(read(BETA_FILE), BETA)
  assert.match(h.text(), /▌Gamma task/)
})

test('D asks first; n keeps the task, y unlinks only its file', async (t) => {
  const { h, read, dir } = await setup(t)
  await h.press('D')
  assert.match(h.text(), /delete t-001 “Alpha task”\? y\/n/)
  await h.press('n')
  assert.equal(read(ALPHA_FILE), ALPHA)
  await h.press('D', 'y')
  assert.ok(!fs.existsSync(path.join(dir, ALPHA_FILE)))
  assert.equal(read(BETA_FILE), BETA)
})

test('i on the list renames the task; YAML survives ": "', async (t) => {
  const { h, read } = await setup(t)
  await h.press('i', 'ctrl+u')
  await h.type('Alpha: renamed')
  await h.press('enter')
  const after = read(ALPHA_FILE)
  assertOnly(ALPHA, after, ['title: Alpha task'], ["title: 'Alpha: renamed'"])
  assert.equal(parseTask(ALPHA_FILE, after).error, undefined)
})

test('i on the todo pane renames the todo under the cursor', async (t) => {
  const { h, read } = await setup(t)
  await h.press('l', 'l', 'i', 'ctrl+u')
  await h.type('first renamed')
  await h.press('enter')
  assertOnly(ALPHA, read(ALPHA_FILE), ['- [ ] first todo'], ['- [ ] first renamed'])
})

test('i with an empty commit is a no-op', async (t) => {
  const { h, read } = await setup(t)
  await h.press('i', 'ctrl+u', 'enter')
  assert.equal(read(ALPHA_FILE), ALPHA)
})

test('t edits tags', async (t) => {
  const { h, read } = await setup(t)
  await h.press('t', 'ctrl+u')
  await h.type('red #blue')
  await h.press('enter')
  assertOnly(ALPHA, read(ALPHA_FILE), ['tags: [one]'], ['tags: [red, blue]'])
})

test('s opens a status picker showing every status, current one marked', async (t) => {
  const { h, read } = await setup(t)
  await h.press('s')
  const text = h.text()
  for (const [n, label] of [[1, 'BACKLOG'], [2, 'WIP'], [3, 'REVIEW'], [4, 'DONE'], [5, 'BLOCK']] as const) {
    assert.match(text, new RegExp(`${n} +${label}`), label)
  }
  assert.match(text, /WIP +✓/)
  assert.doesNotMatch(text, /\d +TODO\b/, 'todo is not a status (the TODO pane label is unrelated)')
  await h.press('esc')
  assert.doesNotMatch(h.text(), /5 +BLOCK/, 'esc closes it')
  assert.equal(read(ALPHA_FILE), ALPHA, 'and writes nothing')
})

test('picker: j then enter sets the next status down', async (t) => {
  const { h, read } = await setup(t)
  await h.press('s', 'j', 'enter')
  assertOnly(ALPHA, read(ALPHA_FILE), ['status: in-progress'], ['status: review'])
})

test('picker: a number picks directly', async (t) => {
  const { h, read } = await setup(t)
  await h.press('s', '5')
  assertOnly(ALPHA, read(ALPHA_FILE), ['status: in-progress'], ['status: blocked'])
})

test('picker: choosing the current status writes nothing', async (t) => {
  const { h, read } = await setup(t)
  await h.press('s', 'enter')
  assert.equal(read(ALPHA_FILE), ALPHA)
})

test('a status shortcut bound in [keys.normal] sets it directly', async (t) => {
  const { h, read } = await setup(t, {}, '[keys.normal]\nB = "status-blocked"\n')
  await h.press('B')
  assertOnly(ALPHA, read(ALPHA_FILE), ['status: in-progress'], ['status: blocked'])
})

test(':status sets the task status', async (t) => {
  const { h, read } = await setup(t)
  await h.press(':')
  await h.type('status done')
  await h.press('enter')
  assertOnly(ALPHA, read(ALPHA_FILE), ['status: in-progress'], ['status: done'])
})

test('enter opens the todo in a third column; esc closes it', async (t) => {
  const { h } = await setup(t)
  await h.press('J', 'enter')
  assert.match(h.text(), /second detail line/)
  await h.press('esc')
  assert.doesNotMatch(h.text(), /second detail line/)
})

test('/ finds tasks by tag and selects the match', async (t) => {
  const { h } = await setup(t)
  await h.press('/')
  await h.type('two')
  await h.press('enter')
  assert.match(h.text(), /▌Beta task/)
  assert.doesNotMatch(h.text(), /Alpha task/)
})

test('/ is fuzzy', async (t) => {
  const { h } = await setup(t)
  await h.press('/')
  await h.type('bta')
  assert.match(h.text(), /▌Beta task/, 'filters live while typing')
  assert.doesNotMatch(h.text(), /Alpha task/)
  await h.press('esc')
  assert.match(h.text(), /Alpha task/, 'esc restores the list')
})

test('/ highlights the matched letters in titles and tags', async (t) => {
  const { h } = await setup(t)
  const line = (text: string) => h.frame().split('\n').find((l) => stripAnsi(l).includes(text)) ?? ''
  await h.press('/')
  await h.type('bta')
  await h.press('enter')
  assert.deepEqual(coloredRuns(line('Beta task'), theme.match), ['B', 'ta'])

  await h.press('/', 'ctrl+u')
  await h.type('#tw')
  await h.press('enter')
  // `0/1  #two` is the list row; the detail pane's meta line also shows `#two`, unhighlighted.
  assert.deepEqual(coloredRuns(line('0/1  #two'), theme.match), ['tw'])
  assert.deepEqual(coloredRuns(line('Beta task'), theme.match), [], '#term never highlights the title')

  await h.press('esc')
  assert.deepEqual(coloredRuns(h.frame(), theme.match), [], 'nothing highlighted without a search')
})

test("every cell is painted with the theme — borders included — so the terminal's own background never shows", async (t) => {
  const { h } = await setup(t)
  for (const keys of [[], ['J', 'enter'], ['/']]) {
    await h.press(...keys)
    assert.equal(unpaintedText(h.frame()), '', `after ${keys.join(' ') || 'start'}`)
  }
})

test('done tasks show by default; H hides them, says how many, and H shows them again', async (t) => {
  const { h } = await setup(t, GAMMA)
  assert.match(h.text(), /Gamma shipped/)
  await h.press('H')
  assert.doesNotMatch(h.text(), /Gamma shipped/)
  assert.match(h.text(), /1 done hidden/)
  await h.press('H')
  assert.match(h.text(), /Gamma shipped/)
  assert.doesNotMatch(h.text(), /done hidden/)
})

test('hide-done in the config starts with done tasks hidden', async (t) => {
  const { h } = await setup(t, GAMMA, '[ui]\nhide-done = true\n')
  assert.doesNotMatch(h.text(), /Gamma shipped/)
  assert.match(h.text(), /2 tasks · 1 done hidden/)
  await h.press('H')
  assert.match(h.text(), /Gamma shipped/)
})

test('marking a task done while done tasks are hidden drops it from the list and says so', async (t) => {
  const { h, read } = await setup(t, {}, '[ui]\nhide-done = true\n')
  await h.press('s', '4')
  assertOnly(ALPHA, read(ALPHA_FILE), ['status: in-progress'], ['status: done'])
  assert.doesNotMatch(h.text(), /Alpha task/)
  assert.match(h.text(), /t-001 done — hidden \(H shows done tasks\)/)
  assert.match(h.text(), /▌Beta task/, 'the cursor moves on to the next task')
})

test('when every task is done and hidden, the empty list says so', async (t) => {
  const { h } = await setup(t, {}, '[ui]\nhide-done = true\n')
  await h.press('s', '4', 's', '4')
  assert.match(h.text(), /all 2 done hidden — H shows them/)
})

test('a note typed under ## Updates without a heading shows, marked undated', async (t) => {
  const { h } = await setup(t, {
    't-004-noted.md': '---\nid: t-004\ntitle: Noted task\nstatus: in-progress\nupdated: 2026-09-24T10:00:00Z\n---\n\n## Updates\n\nBlocked on DBA review\n',
  })
  assert.match(h.text(), /▌Noted task/)
  assert.match(h.text(), /── undated · human ─/)
  assert.match(h.text(), /Blocked on DBA review/)
})

/** Polls until `ok()` — for flows that go through the async $EDITOR hand-off. */
async function until(ok: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
}

/** A config whose [editor] is a script that writes `text` (or nothing) into the file it's given. */
function editorConfig(text: string | undefined) {
  const script = path.join(tempDir('knot-check-editor-'), 'editor.sh')
  fs.writeFileSync(script, text === undefined ? '#!/bin/sh\nexit 0\n' : `#!/bin/sh\nprintf '%s' '${text}' > "$1"\n`, { mode: 0o755 })
  return `[editor]\ncommand = "${script}"\n`
}

const STAMP = /^### \d{4}-\d\d-\d\d \d\d:\d\d — human$/

test('u adds a quick dated update from a human, newest first', async (t) => {
  const { h, read } = await setup(t)
  await h.press('u')
  await h.type('CI green three runs in a row')
  await h.press('enter')
  const { removed, added } = diff(ALPHA, read(ALPHA_FILE))
  assert.deepEqual(removed, [])
  assert.match(added[0], STAMP)
  assert.deepEqual(added.slice(1), ['', 'CI green three runs in a row', ''])
  assert.match(h.text(), /CI green three runs in a row/)
})

test('u with an empty commit, or esc, writes nothing', async (t) => {
  const { h, read } = await setup(t)
  await h.press('u', 'enter', 'u')
  await h.type('never mind')
  await h.press('esc')
  assert.equal(read(ALPHA_FILE), ALPHA)
})

test('U composes a multi-line update in $EDITOR', async (t) => {
  const { h, read } = await setup(t, {}, editorConfig('Found the race.\n\n- retry wrapper removed\n'))
  await h.press('U')
  await until(() => read(ALPHA_FILE) !== ALPHA)
  const { removed, added } = diff(ALPHA, read(ALPHA_FILE))
  assert.deepEqual(removed, [])
  assert.match(added[0], STAMP)
  assert.deepEqual(added.slice(1), ['', 'Found the race.', '', '- retry wrapper removed', ''])
})

test('U left empty in the editor writes nothing and says so', async (t) => {
  const { h, read } = await setup(t, {}, editorConfig(undefined))
  await h.press('U')
  await until(() => /no update/.test(h.text()))
  assert.match(h.text(), /no update/)
  assert.equal(read(ALPHA_FILE), ALPHA)
})

test('c on a task with no dir asks for one, saves it, then launches Claude on that todo', async (t) => {
  const { h, read, dir } = await setup(t)
  const project = tempDir('knot-check-project-')
  await h.press('c')
  assert.match(h.text(), /project dir for t-001/)
  await h.type(project)
  await h.press('enter')
  assertOnly(ALPHA, read(ALPHA_FILE), [], [`dir: ${project}`])
  assert.equal(h.launches.length, 1)
  const [plan] = h.launches
  assert.deepEqual([plan.task, plan.ordinal, plan.dir, plan.env.KNOT_DIR], ['t-001', 1, project, path.resolve(dir)])
  assert.match(plan.prompt, /todo 1 of t-001/)
})

test('C on a task with a dir launches straight away on the whole task', async (t) => {
  const project = tempDir('knot-check-project-')
  const { h } = await setup(t, { [ALPHA_FILE]: ALPHA.replace('tags: [one]\n', `tags: [one]\ndir: ${project}\n`) })
  await h.press('C')
  assert.equal(h.launches.length, 1)
  assert.deepEqual([h.launches[0].ordinal, h.launches[0].dir], [undefined, project])
  assert.match(h.launches[0].prompt, /work on t-001/)
})

test('[claude] clear-between-todos reaches the launch', async (t) => {
  const project = tempDir('knot-check-project-')
  const alpha = { [ALPHA_FILE]: ALPHA.replace('tags: [one]\n', `tags: [one]\ndir: ${project}\n`) }
  const off = await setup(t, alpha)
  await off.h.press('c')
  assert.equal(off.h.launches[0].clearContext, false)
  const on = await setup(t, alpha, '[claude]\nclear-between-todos = true\n')
  await on.h.press('c')
  assert.equal(on.h.launches[0].clearContext, true)
})

test('a dir that does not exist is refused: nothing saved, nothing launched', async (t) => {
  const { h, read } = await setup(t)
  await h.press('c')
  await h.type('/definitely/not/here')
  await h.press('enter')
  assert.match(h.text(), /not a directory/)
  assert.equal(read(ALPHA_FILE), ALPHA)
  assert.equal(h.launches.length, 0)
})

test('the list marks tasks a live Claude session is working on, and refuses to launch another', async (t) => {
  const { h, dir } = await setup(t)
  const proc = spawn('sleep', ['30'], { stdio: 'ignore' })
  t.after(() => proc.kill())
  const pid = proc.pid!
  claimTask(openStore(dir), 't-001', { session: { session: 'other-session', pid, started: processStart(pid)!, host: os.hostname() } })
  await until(() => /◆ claude/.test(h.text()))
  assert.match(h.text(), /WIP ◆ claude/)

  await h.press('C')
  assert.equal(h.launches.length, 0)
  // Named like the CLI and web name it: a session id cut to 8 characters (shortSession).
  assert.match(h.text(), /t-001 is already being worked on by session other-se\b/)

  proc.kill()
  await until(() => !/◆ claude/.test(h.text()))
  assert.doesNotMatch(h.text(), /◆ claude/, 'the marker goes when the session does')
})

test('frames fit the terminal exactly at several sizes', async (t) => {
  for (const [cols, rows] of [[COLS, ROWS], [80, 24], [160, 50]]) {
    const dir = tempDir('knot-check-')
    fs.writeFileSync(path.join(dir, ALPHA_FILE), ALPHA)
    fs.writeFileSync(path.join(dir, BETA_FILE), BETA)
    const h = await startHarness({ dir, cols, rows })
    t.after(() => h.unmount())
    for (const keys of [[], ['J', 'enter']]) {
      await h.press(...keys)
      const lines = h.text().split('\n')
      assert.equal(lines.length, rows, `${cols}x${rows} height`)
      for (const line of lines) assert.ok(strWidth(line) <= cols, `${cols}x${rows}: "${line}"`)
    }
  }
})

test('a task with broken frontmatter is flagged in the list, not hidden', async (t) => {
  const { h } = await setup(t, { 't-009-broken.md': '---\ntitle: [oops\n---\n' })
  await h.press('G')
  assert.match(h.text(), /⚠ t-009-broken/)
  assert.match(h.text(), /1 unparseable/)
})
