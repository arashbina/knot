import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const KNOT = path.join(ROOT, 'bin/knot')

/** What's in the vault besides the `.knot/` runtime state (claims, id reservations); a leaked `.<name>.tmp` still shows. */
const visible = (dir: string) => fs.readdirSync(dir).filter((f) => f !== '.knot')

function vault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-cli-'))
  // Tests are often run from inside a Claude session; don't let its identity leak in.
  const envFor = (env: NodeJS.ProcessEnv) =>
    ({ ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '', KNOT_DIR: dir, KNOT_CONFIG: path.join(dir, 'none.toml'), KNOT_AUTHOR: '', ...env })
  /** `input: null` hands knot /dev/null as stdin, as Claude Code's Bash tool does for a command with no stdin redirect of its own. */
  const run = (args: string[], input?: string | null, env: NodeJS.ProcessEnv = {}, cwd?: string) => {
    const r = spawnSync(KNOT, args, {
      input: input ?? undefined,
      stdio: input === null ? ['ignore', 'pipe', 'pipe'] : 'pipe',
      cwd,
      encoding: 'utf8',
      env: envFor(env),
    })
    return { code: r.status, stdout: r.stdout, stderr: r.stderr }
  }
  /** A shell pipeline around `"$KNOT"`. */
  const sh = (script: string, env: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', env: envFor({ KNOT, ...env }) })
    return { code: r.status, stdout: r.stdout, stderr: r.stderr }
  }
  /** knot's stdin is a socket that `feed` writes to, and may never close, as a node parent gives it. */
  const fed = (args: string[], feed: (stdin: Writable) => void) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const p = spawn(KNOT, args, { env: envFor({}) })
      let stdout = ''
      let stderr = ''
      p.stdout.on('data', (d) => (stdout += d))
      p.stderr.on('data', (d) => (stderr += d))
      const hung = setTimeout(() => { p.kill(); reject(new Error(`knot ${args.join(' ')} hung`)) }, 10_000)
      p.on('close', (code) => {
        clearTimeout(hung)
        p.stdin.destroy()
        resolve({ code, stdout, stderr })
      })
      feed(p.stdin)
    })
  return { dir, run, sh, fed, envFor }
}

/** Well over the 64KB a pipe buffers. */
const BIG_BODY = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}: ${'long enough to fill a pipe buffer. '.repeat(30)}`.trim()).join('\n\n')

/** A stand-in Claude session: a live process whose pid the claim is tied to. */
function fakeSession(t: { after(fn: () => void): void }, name: string) {
  const proc = spawn('sleep', ['60'], { stdio: 'ignore' })
  t.after(() => proc.kill())
  return { env: { CLAUDE_CODE_SESSION_ID: name, CLAUDE_PID: String(proc.pid) }, end: () => proc.kill() }
}

test('help prints the grammar and exits 0', () => {
  const { run } = vault()
  const r = run(['help'])
  assert.equal(r.code, 0)
  assert.match(r.stdout, /^knot — task manager\n/)
  assert.match(r.stdout, /statuses: backlog, in-progress \(wip\), review, done, blocked \(block\)\n$/)
})

test('the agent skill quotes `knot help` verbatim', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills/knot/SKILL.md'), 'utf8')
  const quoted = /## Reference \(`knot help`\)\n\n```\n([\s\S]*?)```/.exec(skill)?.[1]
  assert.equal(quoted, vault().run(['help']).stdout)
})

test('the agent skill runs on any machine: no personal path or shell variable, and every command it uses exists', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills/knot/SKILL.md'), 'utf8')
  assert.doesNotMatch(skill, /\/Users\/|\/home\/|\$KNOT\b|\bKNOT=/)
  assert.match(skill, /^allowed-tools: Bash\(knot \*\)(, Bash\([^)]*\))*$/m)
  const help = vault().run(['help']).stdout
  const commands = new Set(['help', ...[...help.matchAll(/^ {2}knot (\S+)/gm)].map((m) => m[1])])
  const used = [...skill.matchAll(/(?:`|^\s*)knot ([a-z]+)/gm)].map((m) => m[1])
  assert.ok(used.length > 10)
  for (const c of used) assert.ok(commands.has(c), `the skill runs knot ${c}, which knot help doesn't list`)
})

test('full round trip: new with todos, detail, start, update, rename, show --json', () => {
  const { run, dir } = vault()
  const created = JSON.parse(run(['new', 'Parser rework', '--tag', 'a,b', '--todo', 'one', '--todo', 'two', '--json'], 'Body.\n').stdout)
  assert.equal(created.id, 't-001')
  assert.deepEqual(created.todos, { done: 0, total: 2 })
  assert.equal(run(['todo', 'detail', 't-001', '1'], 'Detail for one.\n').code, 0)
  const next = JSON.parse(run(['next', 't-001', '--start', '--json']).stdout)
  assert.equal(next.started, true)
  assert.equal(next.item.ordinal, 1)
  const again = JSON.parse(run(['next', 't-001', '--start', '--json']).stdout)
  assert.equal(again.started, false, 'resuming in-progress work is not a fresh claim')
  assert.equal(run(['update', 't-001', '-m', 'Progress.']).code, 0)
  assert.equal(run(['title', 't-001', 'Parser: rework']).code, 0)

  const shown = JSON.parse(run(['show', 't-001', '--json']).stdout)
  assert.equal(shown.title, 'Parser: rework')
  assert.equal(shown.error, undefined)
  assert.equal(shown.todoItems.length, 2)
  assert.equal(shown.todoItems[0].detail, 'Detail for one.')
  assert.equal(shown.todoItems[0].state, 'in-progress')
  assert.equal(shown.updates[0].author, 'agent', 'stdin is not a TTY here')
  assert.equal(shown.body, 'Body.')
  assert.equal(visible(dir).length, 1)
})

test('todo lifecycle reaches all four states', () => {
  const { run } = vault()
  run(['new', 'x', '--todo', 'a', '--todo', 'b', '--todo', 'c'], '')
  run(['todo', 'done', 't-001', '1'])
  run(['todo', 'start', 't-001'])
  run(['todo', 'cancel', 't-001', '3'])
  let items = JSON.parse(run(['todo', 't-001', '--json']).stdout)
  assert.deepEqual(items.map((i: { state: string }) => i.state), ['done', 'in-progress', 'cancelled'])
  run(['todo', 'reset', 't-001', '2'])
  items = JSON.parse(run(['todo', 't-001', '--json']).stdout)
  assert.equal(items[1].state, 'pending')
})

test('tag add, rm and set', () => {
  const { run } = vault()
  run(['new', 'x', '--tag', 'a'], '')
  run(['tag', 'add', 't-001', 'b,c'])
  run(['tag', 'rm', 't-001', 'a'])
  assert.deepEqual(JSON.parse(run(['show', 't-001', '--json']).stdout).tags, ['b', 'c'])
  run(['tag', 'set', 't-001', 'z'])
  assert.deepEqual(JSON.parse(run(['list', '--tag', 'z', '--json']).stdout).map((t: { id: string }) => t.id), ['t-001'])
})

test('exit codes: 1 for usage, 2 for not found — one line, no stack trace', () => {
  const { run } = vault()
  run(['new', 'x', '--todo', 'a'], '')
  for (const [args, code] of [
    [['bogus'], 1],
    [['status', 't-001', 'nope'], 1],
    [['list', '--wat'], 1],
    [['todo', 'done', 't-001', 'x'], 1],
    [['show', 't-404'], 2],
    [['todo', 'done', 't-001', '9'], 2],
  ] as const) {
    const r = run([...args])
    assert.equal(r.code, code, args.join(' '))
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace')
  }
})

test('status takes a name or the wip alias; todo is no longer a status', () => {
  const { run } = vault()
  run(['new', 'x'], '')
  assert.equal(run(['status', 't-001', 'wip']).code, 0)
  assert.equal(JSON.parse(run(['show', 't-001', '--json']).stdout).status, 'in-progress')
  assert.deepEqual(JSON.parse(run(['list', '--status', 'wip', '--json']).stdout).map((t: { id: string }) => t.id), ['t-001'])
  const refused = run(['status', 't-001', 'todo'])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /one of backlog, in-progress \(wip\), review, done, blocked \(block\)\n/, 'names every alias')
  assert.equal(run(['new', 'y', '--status', 'todo'], '').code, 1)
})

test('next with nothing left exits 2', () => {
  const { run } = vault()
  run(['new', 'x', '--todo', 'a'], '')
  run(['todo', 'done', 't-001', '1'])
  assert.equal(run(['next', 't-001']).code, 2)
})

test('broken frontmatter is flagged in list, not hidden', () => {
  const { run, dir } = vault()
  fs.writeFileSync(path.join(dir, 't-007-broken.md'), '---\ntitle: [oops\n---\n')
  const rows = JSON.parse(run(['list', '--json']).stdout)
  assert.equal(rows.length, 1)
  assert.ok(rows[0].error)
  assert.equal(run(['show', 't-007']).code, 0)
})

test('a missing vault fails loudly for reads and is created by new', () => {
  const { run, dir } = vault()
  fs.rmSync(dir, { recursive: true })
  assert.equal(run(['list']).code, 2)
  assert.equal(run(['new', 'first'], '').code, 0)
  assert.equal(visible(dir).length, 1)
})

test('new reads todos with their detail from a ## Todo section on stdin; --todo items follow', () => {
  const { run, dir } = vault()
  const input = 'Why this matters.\n\n## Todo\n\n- [ ] First step\n    Context: see src/a.ts:12\n\n    - [ ] sub-step stays in the detail\n- [ ] Second step\n'
  const r = run(['new', 'With context', '--todo', 'Third step', '--json'], input)
  assert.equal(r.code, 0, r.stderr)
  const shown = JSON.parse(run(['show', 't-001', '--json']).stdout)
  assert.equal(shown.body, 'Why this matters.')
  assert.deepEqual(shown.todoItems.map((t: { text: string }) => t.text), ['First step', 'Second step', 'Third step'])
  assert.equal(shown.todoItems[0].detail, 'Context: see src/a.ts:12\n\n- [ ] sub-step stays in the detail')
  const raw = fs.readFileSync(path.join(dir, 't-001-with-context.md'), 'utf8')
  assert.equal(raw.match(/^## Todo$/gm)?.length, 1, 'one Todo section, not a copy inside the body')
})

test('new refuses an ## Updates section on stdin rather than dropping it', () => {
  const { run } = vault()
  assert.equal(run(['new', 'x'], 'Body\n\n## Updates\n\n### 2026-01-01 10:00 — agent\n\nhi\n').code, 1)
})

test('new keeps a fenced ## Todo / ## Updates example as body instead of refusing it', () => {
  const { run } = vault()
  const input = 'Format example:\n\n```md\n## Todo\n\n- [ ] example item\n## Updates\n```\n\nAfter fence.\n'
  const r = run(['new', 'x', '--json'], input)
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).todos, { done: 0, total: 0 })
  const shown = JSON.parse(run(['show', 't-001', '--json']).stdout)
  assert.equal(shown.body, input.trim())
  assert.deepEqual(shown.updates, [])

  const withTodo = run(['new', 'y', '--json'], `${input}\n## Todo\n\n- [ ] real\n`)
  assert.equal(withTodo.code, 0, withTodo.stderr)
  const second = JSON.parse(run(['show', 't-002', '--json']).stdout)
  assert.equal(second.body, input.trim())
  assert.deepEqual(second.todoItems.map((t: { text: string }) => t.text), ['real'], 'the fenced checkbox is not a todo')
})

test('todo detail --append adds to the detail instead of replacing it', () => {
  const { run } = vault()
  run(['new', 'x', '--todo', 'a'], '')
  run(['todo', 'detail', 't-001', '1'], 'Original context.\n')
  assert.equal(run(['todo', 'detail', 't-001', '1', '--append'], 'Found: the retry masks it.\n').code, 0)
  assert.equal(JSON.parse(run(['todo', 'show', 't-001', '1', '--json']).stdout).detail, 'Original context.\n\nFound: the retry masks it.')
})

/** Each case must exit 1 and leave the task file byte for byte as it was. */
function assertRefused(file: string, cases: ReadonlyArray<readonly [() => { code: number | null; stderr: string }, string]>) {
  const before = fs.readFileSync(file, 'utf8')
  for (const [attempt, why] of cases) {
    const r = attempt()
    assert.equal(r.code, 1, `${why}: ${r.stderr}`)
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace')
    assert.equal(fs.readFileSync(file, 'utf8'), before, `${why}: the file is untouched`)
  }
}

test('body never erases by accident: empty stdin and text as an argument are refused; --clear empties it', () => {
  const { run, sh, dir } = vault()
  run(['new', 'x'], 'Important prose.\n\n## Notes\n\nkeep me\n\n## Todo\n\n- [ ] first\n    detail of first\n')
  assertRefused(path.join(dir, 't-001-x.md'), [
    [() => run(['body', 't-001'], null), 'stdin is /dev/null'],
    [() => sh('exec "$KNOT" body t-001 <&-'), 'stdin is closed'],
    [() => run(['body', 't-001'], ''), 'empty stdin'],
    [() => run(['body', 't-001'], ' \n\n'), 'blank stdin'],
    [() => run(['body', 't-001', 'New prose.'], null), 'the text as an argument'],
    [() => run(['body', 't-001', 'New prose.'], 'Piped prose.\n'), 'an argument besides stdin'],
  ])

  assert.equal(run(['body', 't-001'], 'New prose.\n').code, 0)
  assert.equal(JSON.parse(run(['show', 't-001', '--json']).stdout).body, 'New prose.')
  assert.equal(run(['body', 't-001', '--clear'], null).code, 0)
  const shown = JSON.parse(run(['show', 't-001', '--json']).stdout)
  assert.equal(shown.body, '')
  assert.equal(shown.todoItems[0].detail, 'detail of first', 'todos are not body')
})

test('todo detail never erases by accident: empty stdin and text as arguments are refused; --clear removes it', () => {
  const { run, dir } = vault()
  run(['new', 'x'], '## Todo\n\n- [ ] first\n    Context that matters.\n- [ ] second\n    More context.\n')
  const detail = ['todo', 'detail', 't-001', '1']
  assertRefused(path.join(dir, 't-001-x.md'), [
    [() => run(detail, null), 'stdin is /dev/null'],
    [() => run(detail, ''), 'empty stdin'],
    [() => run(detail, '\n  \n'), 'blank stdin'],
    [() => run([...detail, 'Found: the race'], null), 'the text as an argument'],
    [() => run([...detail, '--append', 'Found: the race'], null), '--append "text"'],
    [() => run([...detail, '--append'], null), 'nothing to append'],
    [() => run([...detail, '--append'], '\n'), 'blank to append'],
    [() => run([...detail, '--append', '--clear'], null), '--append with --clear'],
  ])

  assert.equal(run([...detail, '--clear'], null).code, 0)
  const items = JSON.parse(run(['todo', 't-001', '--json']).stdout)
  assert.deepEqual(items.map((i: { text: string; detail: string }) => [i.text, i.detail]), [['first', ''], ['second', 'More context.']])
})

test('update never drops text: stray arguments are refused; a quoted -m or stdin lands whole', () => {
  const { run, dir } = vault()
  run(['new', 'x'], '')
  assertRefused(path.join(dir, 't-001-x.md'), [
    [() => run(['update', 't-001', '-m', 'Found', 'the', 'race'], null), '-m text left unquoted'],
    [() => run(['update', 't-001', 'Positional note'], 'Piped note.\n'), 'an argument besides stdin'],
    [() => run(['update', 't-001', 'Positional note'], null), 'the text as an argument'],
  ])

  assert.equal(run(['update', 't-001', '-m', 'Found the race in retry.'], null).code, 0)
  assert.equal(run(['update', 't-001'], 'Piped note.\n').code, 0)
  const bodies = JSON.parse(run(['show', 't-001', '--json']).stdout).updates.map((u: { body: string }) => u.body)
  assert.deepEqual(bodies.sort(), ['Found the race in retry.', 'Piped note.'])
})

test('update takes its text once: a repeated -m, or -m with piped text, is refused', () => {
  const { run, dir } = vault()
  run(['new', 'x'], '')
  assertRefused(path.join(dir, 't-001-x.md'), [
    [() => run(['update', 't-001', '-m', 'First.', '-m', 'Second.'], null), 'two -m'],
    [() => run(['update', 't-001', '-m', 'Typed.'], 'Piped too.\n'), '-m and piped text'],
  ])
  assert.equal(run(['update', 't-001', '-m', 'Typed.'], '').code, 0, 'an empty pipe beside -m is no text')
})

test('new reads all of a slow, large pipe', (t) => {
  const { run, sh } = vault()
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-pipe-'))
  t.after(() => fs.rmSync(src, { recursive: true, force: true }))
  fs.writeFileSync(path.join(src, 'big.md'), `${BIG_BODY}\n\n## Todo\n\n- [ ] one\n`)
  // Slower to start than knot, and a pause mid-stream.
  const r = sh(`{ sleep 0.5; cat "$BIG"; sleep 0.3; echo '- [ ] two'; } | "$KNOT" new Big --json`, { BIG: path.join(src, 'big.md') })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).todos, { done: 0, total: 2 })
  assert.equal(JSON.parse(run(['show', 't-001', '--json']).stdout).body, BIG_BODY)
})

test('new reads all of a large stdin socket whose writer pauses mid-stream', async () => {
  const { run, fed } = vault()
  const r = await fed(['new', 'Big', '--json'], (stdin) => {
    stdin.write(BIG_BODY.slice(0, 100_000))
    setTimeout(() => stdin.end(`${BIG_BODY.slice(100_000)}\n\n## Todo\n\n- [ ] one\n`), 700)
  })
  assert.equal(r.code, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).todos, { done: 0, total: 1 })
  assert.equal(JSON.parse(run(['show', 't-001', '--json']).stdout).body, BIG_BODY)
})

test("a stdin socket nobody writes to or closes (Claude Code's Bash tool hands one over whenever the command has a heredoc or `<` redirect) is no input, not a hang", async () => {
  const { fed, dir } = vault()
  const silent = () => {}
  const created = await fed(['new', 'x', '--todo', 'a'], silent)
  assert.equal(created.code, 0, created.stderr)
  const file = path.join(dir, 't-001-x.md')
  const before = fs.readFileSync(file, 'utf8')
  assert.equal((await fed(['body', 't-001'], silent)).code, 1)
  assert.equal((await fed(['todo', 'detail', 't-001', '1'], silent)).code, 1)
  assert.equal((await fed(['update', 't-001'], silent)).code, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

test('claim: one live session at a time; exit 3 names the holder; a dead session frees the task', (t) => {
  const { run } = vault()
  run(['new', 'x', '--todo', 'a'], '')
  const a = fakeSession(t, 'session-a')
  const b = fakeSession(t, 'session-b')

  assert.equal(run(['claim', 't-001'], undefined, a.env).code, 0)
  assert.equal(run(['claim', 't-001'], undefined, a.env).code, 0, 'the holder can re-claim')
  const refused = run(['claim', 't-001'], undefined, b.env)
  assert.equal(refused.code, 3)
  assert.match(refused.stderr, /session-a/)

  const asB = JSON.parse(run(['show', 't-001', '--json'], undefined, b.env).stdout)
  assert.equal(asB.claim.session, 'session-a')
  assert.equal(asB.claim.mine, false)
  assert.equal(JSON.parse(run(['show', 't-001', '--json'], undefined, a.env).stdout).claim.mine, true)

  a.end()
  spawnSync('sleep', ['0.2'])
  assert.equal(run(['claim', 't-001'], undefined, b.env).code, 0, 'session-a is gone, so its claim is stale')
  assert.equal(JSON.parse(run(['show', 't-001', '--json']).stdout).claim.session, 'session-b')
})

test('another Claude session cannot change a claimed task; the holder and a human can', (t) => {
  const { run } = vault()
  run(['new', 'x', '--todo', 'a', '--todo', 'b'], '')
  const a = fakeSession(t, 'session-a')
  const b = fakeSession(t, 'session-b')
  run(['claim', 't-001'], undefined, a.env)

  const blocked = run(['todo', 'done', 't-001', '1'], undefined, b.env)
  assert.equal(blocked.code, 3)
  assert.match(blocked.stderr, /being worked on by another session/)
  assert.equal(run(['todo', 'done', 't-001', '1'], undefined, a.env).code, 0)
  assert.equal(run(['todo', 'done', 't-001', '2']).code, 0, 'a person at a terminal is never locked out')
  assert.equal(run(['show', 't-001'], undefined, b.env).code, 0, 'reads are always fine')
})

test('outside Claude, a claim is tied to the process that ran knot: live, mine, resumable, and it holds off Claude sessions', (t) => {
  const { run } = vault()
  run(['new', 'x', '--todo', 'a'], '')
  const first = JSON.parse(run(['claim', 't-001', '--json']).stdout)
  assert.equal(first.claimed, true)
  assert.equal(first.claim.pid, process.pid, 'this test process ran knot')
  assert.equal(JSON.parse(run(['show', 't-001', '--json']).stdout).claim?.mine, true)
  assert.equal(JSON.parse(run(['list', '--json']).stdout)[0].claim?.mine, true)
  const again = JSON.parse(run(['claim', 't-001', '--json'], undefined, { KNOT_CALLER_PID: '1' }).stdout)
  assert.equal(again.resumed, true, 'the same caller, whatever KNOT_CALLER_PID it inherited')

  const claude = fakeSession(t, 'session-b')
  const blocked = run(['todo', 'done', 't-001', '1'], undefined, claude.env)
  assert.equal(blocked.code, 3)
  assert.match(blocked.stderr, new RegExp(`session pid-${process.pid}`))
  assert.equal(run(['release', 't-001']).code, 0)
  assert.equal(JSON.parse(run(['show', 't-001', '--json']).stdout).claim, undefined)
})

test('list names a claim held by another shell by its whole pid, not a cut-off one', async (t) => {
  const { run, envFor } = vault()
  run(['new', 'x'], '')
  // The shell claims the task, then stays alive (same pid) so its claim does.
  const shell = spawn('/bin/sh', ['-c', '"$KNOT" claim t-001 && exec sleep 60'], { env: envFor({ KNOT }), stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => shell.kill())
  // If the claim fails the shell just exits; don't wait forever for output that never comes.
  await Promise.race([once(shell.stdout, 'data'), once(shell, 'exit').then(() => assert.fail('the claim failed'))])
  const holder = `pid-${shell.pid}`
  assert.equal(JSON.parse(run(['list', '--json']).stdout)[0].claim?.session, holder)
  assert.match(run(['list']).stdout, new RegExp(`\\[claimed by session ${holder}\\]\n`))
})

test('release: by the holder, or --force; list --json shows who holds what', (t) => {
  const { run } = vault()
  run(['new', 'x'], '')
  const a = fakeSession(t, 'session-a')
  const b = fakeSession(t, 'session-b')
  run(['claim', 't-001'], undefined, a.env)
  assert.equal(JSON.parse(run(['list', '--json']).stdout)[0].claim.session, 'session-a')
  assert.equal(run(['release', 't-001'], undefined, b.env).code, 3)
  assert.equal(run(['release', 't-001'], undefined, a.env).code, 0)
  assert.equal(JSON.parse(run(['list', '--json']).stdout)[0].claim, undefined)
  run(['claim', 't-001'], undefined, a.env)
  assert.equal(run(['release', 't-001', '--force'], undefined, b.env).code, 0)
})

test('dir: set on new or later, shown by show --json, stored absolute, must exist, --clear removes it', () => {
  const { run } = vault()
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'knot-project-')))
  assert.equal(run(['new', 'x', '--dir', project], '').code, 0)
  assert.equal(JSON.parse(run(['show', 't-001', '--json']).stdout).dir, project)
  assert.equal(run(['dir', 't-001']).stdout.trim(), project)

  assert.equal(run(['new', 'y', '--dir', path.join(project, 'nope')], '').code, 1, 'not a directory')
  assert.equal(run(['dir', 't-001', path.join(project, 'nope')]).code, 1)

  fs.mkdirSync(path.join(project, 'sub'))
  assert.equal(run(['dir', 't-001', 'sub'], undefined, {}, project).code, 0)
  assert.equal(run(['dir', 't-001']).stdout.trim(), path.join(project, 'sub'), 'relative to where knot ran')

  assert.equal(run(['dir', 't-001', '--clear']).code, 0)
  assert.equal(JSON.parse(run(['show', 't-001', '--json']).stdout).dir, undefined)
})
