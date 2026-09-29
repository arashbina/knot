import fs from 'node:fs'
import path from 'node:path'
import tty from 'node:tty'
import {
  STATUS_LIST, UI_FIELDS, addTodo, addUpdate, allTags, claimInfo, claimTask, claimsById, configPath, createTask, deleteTask,
  expandHome, filterTasks, firstLine, inClaude, initConfig, liveClaim, load, loadAll, loadConfig, nextTodo, normalizeTags,
  openStore, parseStatus, parseTask, releaseTask, removeTodo, resolveProjectDir, resolveVault, scanSections, sessionId, setBody,
  setDir, setStatus, setTags, setTitle, setTodoDetail, setTodoState, setTodoText, sortTasks, spawnEditor, splitLines,
  taskDetail, taskSummary, todoLine, NotFoundError,
  type Author, type Claim, type ClaimInfo, type LoadedConfig, type Store, type Task, type TaskStatus, type TodoState,
  type UiConfig,
} from '@knot-tui/core'
import { UsageError, parseArgs, splitList, type Args } from './args.js'
import { HELP, listRows, showTask, showTodo, todoRow } from './format.js'

/** Another live session holds the task. Exit 3. */
class ClaimedError extends Error {}

const out = (text: string) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
const json = (value: unknown) => out(JSON.stringify(value, null, 2))

let loadedConfig: LoadedConfig | undefined
function config(): LoadedConfig {
  if (!loadedConfig) {
    loadedConfig = loadConfig()
    if (loadedConfig.error) process.stderr.write(`knot: config ${loadedConfig.path}: ${loadedConfig.error}\n`)
  }
  return loadedConfig
}

function store(create = false): Store {
  return openStore(resolveVault(config()), { create })
}

function task(s: Store, id: string | undefined): Task {
  if (!id) throw new UsageError('missing <id>')
  const t = load(s, id)
  if (!t) throw new NotFoundError(`no task ${id}`)
  return t
}

function describe(c: Claim): string {
  return `session ${c.session}, pid ${c.pid}${c.host ? ` on ${c.host}` : ''}, since ${c.since}`
}

function claimFor(s: Store, t: Task): ClaimInfo | undefined {
  const c = liveClaim(s, t.id)
  return c && claimInfo(c, sessionId())
}

/**
 * A task this caller may change. Another Claude session's live claim locks it — the
 * backstop for "don't interfere with a session already working on it". A person at a
 * terminal is never locked out.
 */
function writable(s: Store, id: string | undefined): Task {
  const t = task(s, id)
  if (!inClaude()) return t
  const held = liveClaim(s, t.id)
  if (held && held.session !== sessionId()) {
    throw new ClaimedError(`${t.id} is being worked on by another session (${describe(held)}) — \`knot claim ${t.id} --force\` takes over`)
  }
  return t
}

function ordinal(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value) || Number(value) < 1) throw new UsageError(`expected a todo number, got ${value ?? 'nothing'}`)
  return Number(value)
}

function status(value: string | undefined): TaskStatus {
  const parsed = value === undefined ? undefined : parseStatus(value)
  if (!parsed) throw new UsageError(`unknown status ${value ?? '(none)'}; one of ${STATUS_LIST}`)
  return parsed
}

/** A project directory: `~` expanded, made absolute against the cwd, and required to exist. */
function projectDir(value: string): string {
  const dir = resolveProjectDir(value)
  if (!dir) throw new UsageError(`not a directory: ${path.resolve(expandHome(value))}`)
  return dir
}

/**
 * What was piped or redirected in; undefined when nothing was. A character device is a TTY
 * (never prompt) or /dev/null, which node also puts on a closed fd 0. Shell pipes, heredocs
 * and redirects are read to EOF like `cat` does, however slow the writer — without touching
 * `process.stdin` first, which makes a pipe non-blocking and loses a slow writer to EAGAIN.
 */
function stdin(): string | undefined {
  const fd0 = fs.fstatSync(0)
  if (fd0.isCharacterDevice()) return undefined
  return fd0.isSocket() ? socketInput() : fs.readFileSync(0, 'utf8')
}

/** How long a socket on stdin may stay silent before it counts as no input. */
const SOCKET_GRACE_MS = 200

/**
 * A socket on stdin is what a node parent hands over: spawnSync's `input`, or Claude Code's
 * Bash tool whenever the command text looks like it redirects stdin itself — a heredoc,
 * here-string or a spaced `<`, even inside quotes (observed, not documented); routine, since the knot skill uses
 * `<<'EOF'`. The tool then skips its own `< /dev/null`, and every process in the command gets
 * a socket the tool never writes to or closes — a blocking read would hang. So read it
 * non-blocking: silent past the grace period is no input; once data flows, read to EOF.
 */
function socketInput(): string | undefined {
  void process.stdin // switches fd 0 to non-blocking
  const nap = new Int32Array(new SharedArrayBuffer(4))
  const buf = Buffer.alloc(64 * 1024)
  const chunks: Buffer[] = []
  const since = Date.now()
  for (;;) {
    let n: number
    try { n = fs.readSync(0, buf) }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e
      if (!chunks.length && Date.now() - since > SOCKET_GRACE_MS) return undefined
      Atomics.wait(nap, 0, 0, 10)
      continue
    }
    if (n === 0) return Buffer.concat(chunks).toString('utf8')
    chunks.push(Buffer.from(buf.subarray(0, n)))
  }
}

function author(): Author {
  const env = process.env.KNOT_AUTHOR
  if (env === 'human' || env === 'agent') return env
  return tty.isatty(0) ? 'human' : 'agent'
}

function text(parts: string[], what: string): string {
  const value = parts.join(' ').trim()
  if (!value) throw new UsageError(`missing <${what}>`)
  return value
}

function cmdList(a: Args) {
  const filter = {
    status: splitList(a.flagAll('status')).map(status),
    tags: normalizeTags(splitList(a.flagAll('tag'))),
    text: a.flag('text'),
  }
  const s = store()
  const tasks = sortTasks(filterTasks(loadAll(s), filter))
  const claims = claimsById(s, sessionId())
  if (a.has('json')) json(tasks.map((t) => taskSummary(t, claims.get(t.id))))
  else if (tasks.length) out(listRows(tasks, claims))
}

/**
 * stdin is the body, and may carry a `## Todo` section whose items — with their
 * indented detail — become the task's todos, so a task with per-todo context is one call.
 */
function cmdNew(a: Args) {
  const title = text(a.pos.slice(1), 'title')
  const dir = a.has('dir') ? projectDir(a.flag('dir')!) : undefined
  const input = stdin() ?? ''
  if (scanSections(splitLines(input)).some((sec) => sec.kind === 'updates')) {
    throw new UsageError('stdin has an ## Updates section (a code block can\'t hold an update heading: that ends the block); create the task, then add updates with `knot update`')
  }
  const parsed = parseTask('stdin.md', input)
  const created = createTask(store(true), {
    title,
    status: a.has('status') ? status(a.flag('status')) : undefined,
    tags: splitList(a.flagAll('tag')),
    todos: [
      ...parsed.todos.map((t) => ({ text: t.text, detail: t.detail, state: t.state })),
      ...a.flagAll('todo'),
    ],
    body: parsed.body,
    dir,
  })
  if (a.has('json')) json(taskSummary(created))
  else out(created.id)
}

function cmdTag(a: Args) {
  const [, op, id, ...rest] = a.pos
  if (!['add', 'rm', 'set'].includes(op)) throw new UsageError('usage: knot tag add|rm|set <id> a,b')
  const t = writable(store(), id)
  const given = normalizeTags(splitList(rest))
  if (op !== 'set' && !given.length) throw new UsageError('missing tags')
  const next = op === 'set' ? given
    : op === 'add' ? [...t.tags, ...given]
    : t.tags.filter((x) => !given.includes(x))
  out(setTags(t, next).tags.map((x) => `#${x}`).join(' ') || '(no tags)')
}

function cmdUpdate(a: Args) {
  if (a.pos.length > 2) throw new UsageError('the update goes in -m "text" (quoted) or on stdin, not in arguments')
  if (a.flagAll('m').length > 1) throw new UsageError('give the update once: one -m "text", or stdin')
  const t = writable(store(), a.pos[1])
  const piped = stdin()
  if (a.has('m') && piped?.trim()) throw new UsageError('give the update once: -m "text" or stdin, not both')
  const body = a.flag('m') ?? piped
  if (!body?.trim()) throw new UsageError('pass the update with -m "text" or on stdin')
  const who = author()
  addUpdate(t, body, who)
  out(`${t.id}: update added (${who})`)
}

const TODO_SUBCOMMANDS = new Set(['add', 'show', 'detail', 'edit', 'rm', 'done', 'start', 'reset', 'cancel'])
const STATE_FOR: Record<string, TodoState> = { done: 'done', reset: 'pending', cancel: 'cancelled', start: 'in-progress' }

function cmdTodo(a: Args) {
  const [, sub, id, n, ...rest] = a.pos
  if (!TODO_SUBCOMMANDS.has(sub)) {
    const t = task(store(), sub)
    if (a.has('json')) json(t.todos)
    else if (t.todos.length) out(t.todos.map(todoRow).join('\n'))
    return
  }
  const t = sub === 'show' ? task(store(), id) : writable(store(), id)
  const row = (next: Task, k: number) => void out(todoRow(todoLine(next, k)))
  switch (sub) {
    case 'add': {
      const next = addTodo(t, text([n, ...rest].filter((x) => x !== undefined), 'text'))
      out(todoRow(next.todos.at(-1)!))
      return
    }
    case 'show': {
      const item = todoLine(t, ordinal(n))
      if (a.has('json')) json(item)
      else out(showTodo(item))
      return
    }
    case 'detail': {
      if (rest.length) throw new UsageError('the detail goes on stdin (a heredoc), not in arguments')
      const k = ordinal(n)
      if (a.has('clear')) {
        if (a.has('append')) throw new UsageError('--append and --clear contradict each other')
        return row(setTodoDetail(t, k, ''), k)
      }
      const body = stdin()
      if (!body?.trim()) throw new UsageError(a.has('append') ? 'nothing to append: pipe it on stdin' : 'pipe the detail on stdin (--clear removes it)')
      const existing = a.has('append') ? todoLine(t, k).detail : ''
      return row(setTodoDetail(t, k, existing ? `${existing}\n\n${body.trim()}` : body), k)
    }
    case 'edit': {
      const k = ordinal(n)
      return row(setTodoText(t, k, text(rest, 'text')), k)
    }
    case 'rm': {
      const item = todoLine(t, ordinal(n))
      removeTodo(t, item.ordinal)
      out(`removed #${item.ordinal} ${item.text} — todos below it are renumbered`)
      return
    }
    case 'start': {
      const target = n === undefined
        ? t.todos.find((x) => x.state === 'pending')
        : todoLine(t, ordinal(n))
      if (!target) throw new NotFoundError(`no pending todo on ${t.id}`)
      return row(setTodoState(t, target.ordinal, 'in-progress'), target.ordinal)
    }
    default: {
      const k = ordinal(n)
      return row(setTodoState(t, k, STATE_FOR[sub]), k)
    }
  }
}

function cmdNext(a: Args) {
  let t = a.has('start') ? writable(store(), a.pos[1]) : task(store(), a.pos[1])
  let item = nextTodo(t)
  if (!item) throw new NotFoundError(`nothing left on ${t.id}`)
  let started = false
  if (a.has('start') && item.state === 'pending') {
    t = setTodoState(t, item.ordinal, 'in-progress')
    item = todoLine(t, item.ordinal)
    started = true
  }
  if (a.has('json')) {
    json({ task: taskSummary(t), item, started })
    return
  }
  const note = started ? 'started' : item.state === 'in-progress' ? 'already in progress' : 'not started'
  out(`${t.id}  ${showTodo(item)}\n(${note})`)
}

function cmdClaim(a: Args) {
  const s = store()
  const t = task(s, a.pos[1])
  const r = claimTask(s, t.id, { force: a.has('force') })
  if (a.has('json')) json(r.ok ? { claimed: true, resumed: r.resumed, claim: r.claim } : { claimed: false, holder: r.holder })
  if (!r.ok) throw new ClaimedError(`${t.id} is being worked on by another session (${describe(r.holder)})`)
  if (!a.has('json')) out(`${t.id}: ${r.resumed ? 'already claimed by this session' : 'claimed'}`)
}

function cmdRelease(a: Args) {
  const s = store()
  const t = task(s, a.pos[1])
  const holder = liveClaim(s, t.id)
  if (!releaseTask(s, t.id, { force: a.has('force') })) throw new ClaimedError(`${t.id} is held by another session (${describe(holder!)}) — --force releases it anyway`)
  out(`${t.id}: released`)
}

function cmdConfig(a: Args) {
  const sub = a.pos[1] ?? 'show'
  if (sub === 'path') {
    out(configPath())
    return
  }
  if (sub === 'init') {
    const r = initConfig()
    out(`${r.created ? 'created' : 'exists'} ${r.path}`)
    return
  }
  if (sub !== 'show') throw new UsageError('usage: knot config [path|init|show]')
  const loaded = config()
  const { ui, keys, editor } = loaded.config
  const exists = fs.existsSync(loaded.path)
  out([
    `file: ${loaded.path}${exists ? '' : ' (missing — `knot config init` writes a commented default)'}`,
    ...(loaded.error ? [`error: ${loaded.error}`] : []),
    `vault: ${resolveVault(loaded)}`,
    `editor: ${editor.command ?? '(from $VISUAL / $EDITOR)'}`,
    '',
    '[ui]',
    ...Object.entries(UI_FIELDS).map(([key, field]) => `${field.name} = ${ui[key as keyof UiConfig]}`),
    '',
    '[claude]',
    `clear-between-todos = ${loaded.config.claude.clearBetweenTodos}`,
    ...(Object.keys(keys).length ? ['', '[keys.normal]', ...Object.entries(keys).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)] : []),
  ].join('\n'))
}

function run(argv: string[]): void {
  const [cmd = 'help'] = argv
  const a = parseArgs(argv)
  if (a.has('help') || cmd === 'help') return void out(HELP)
  const [, id, ...rest] = a.pos

  switch (cmd) {
    case 'list': return cmdList(a)
    case 'show': {
      const s = store()
      const t = task(s, id)
      const claim = claimFor(s, t)
      return void (a.has('json') ? json(taskDetail(t, claim)) : out(showTask(t, claim)))
    }
    case 'new': return cmdNew(a)
    case 'claim': return cmdClaim(a)
    case 'release': return cmdRelease(a)
    case 'rm': {
      const t = writable(store(), id)
      deleteTask(t)
      return void out(`removed ${t.id} ${t.title}`)
    }
    case 'status': {
      const t = setStatus(writable(store(), id), status(rest[0]))
      return void out(`${t.id}: ${t.status}`)
    }
    case 'title': {
      const t = setTitle(writable(store(), id), text(rest, 'text'))
      return void out(`${t.id}: ${t.title}`)
    }
    case 'body': {
      if (rest.length) throw new UsageError('the body goes on stdin (a heredoc), not in arguments')
      const t = writable(store(), id)
      if (a.has('clear')) {
        setBody(t, '')
        return void out(`${t.id}: body cleared`)
      }
      const body = stdin()
      if (!body?.trim()) throw new UsageError('pipe the new body on stdin (--clear empties it)')
      setBody(t, body)
      return void out(`${t.id}: body replaced`)
    }
    case 'tag': return cmdTag(a)
    case 'dir': {
      if (a.has('clear')) {
        setDir(writable(store(), id), undefined)
        return void out(`${id}: dir cleared`)
      }
      if (!rest.length) {
        const t = task(store(), id)
        return void (t.dir ? out(t.dir) : process.stderr.write(`knot: ${t.id} has no dir\n`))
      }
      const t = setDir(writable(store(), id), projectDir(rest.join(' ')))
      return void out(`${t.id}: ${t.dir}`)
    }
    case 'edit': {
      const t = writable(store(), id)
      const code = spawnEditor(t.file, config().config)
      if (code !== 0) process.exitCode = code
      return
    }
    case 'update': return cmdUpdate(a)
    case 'todo': return cmdTodo(a)
    case 'next': return cmdNext(a)
    case 'tags': {
      const tags = allTags(loadAll(store()))
      if (a.has('json')) json(tags)
      else if (tags.length) out(tags.map((t) => `${t.tag}  ${t.count}`).join('\n'))
      return
    }
    case 'config': return cmdConfig(a)
    default: throw new UsageError(`unknown command: ${cmd}`)
  }
}

// An agent must never see a stack trace: everything becomes one line and an exit code:
// 1 usage, 2 not found (or any core error), 3 claimed by another session.
try {
  run(process.argv.slice(2))
} catch (e) {
  const message = firstLine(e)
  if (e instanceof UsageError) {
    process.stderr.write(`knot: ${message}\nrun \`knot help\` for usage\n`)
    process.exitCode = 1
  } else if (e instanceof ClaimedError) {
    process.stderr.write(`knot: ${message}\n`)
    process.exitCode = 3
  } else {
    process.stderr.write(`knot: ${message}\n`)
    process.exitCode = 2
  }
}
