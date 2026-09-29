import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, useInput } from 'ink'
import {
  TASK_STATUSES, firstLine, listView, normalizeTags, progress, resolveProjectDir, shortSession, splitTrailingTags, tildify,
  type Author, type CreateTaskInput, type LoadedConfig, type Task, type TaskStatus, type TodoItem, type TodoState,
} from '@knot-tui/core'
import { parseCommand } from './commands.js'
import { detailLines } from './components/DetailPane.js'
import { openLines } from './components/OpenTodoPane.js'
import { Row, ScrollPane, spread } from './components/Pane.js'
import { TaskList } from './components/TaskList.js'
import { StatusPicker } from './components/StatusPicker.js'
import { TodoPane } from './components/TodoPane.js'
import { inputLine, useLineEditor } from './hooks/useLineEditor.js'
import { useSelection } from './hooks/useSelection.js'
import { buildKeymap, keyFor, keyName, resolveKey, statusOfAction, type Action, type Keymap } from './keys.js'
import { computeLayout } from './layout.js'
import { theme } from './theme.js'
import { truncateLine, type Line } from './text.js'
import { clamp, follow, position } from './viewport.js'

/** Every write the TUI can make. Injected, so App never touches the store. */
export interface Ops {
  createTask(input: CreateTaskInput): Task
  deleteTask(task: Task): void
  setTitle(task: Task, title: string): Task
  setTags(task: Task, tags: string[]): Task
  setStatus(task: Task, status: TaskStatus): Task
  setTodoState(task: Task, ordinal: number, state: TodoState): Task
  setTodoText(task: Task, ordinal: number, text: string): Task
  addTodo(task: Task, text: string): Task
  removeTodo(task: Task, ordinal: number): Task
  addUpdate(task: Task, body: string, author: Author): Task
  setDir(task: Task, dir: string | undefined): Task
}

export interface AppProps {
  tasks: Task[]
  vault: string
  config: LoadedConfig
  cols: number
  rows: number
  ops: Ops
  onEditFile(file: string): Promise<void>
  onEditConfig(): Promise<LoadedConfig>
  /** Opens $EDITOR on a template; resolves to the text written, or undefined if the editor failed. */
  onComposeUpdate(task: Task): Promise<string | undefined>
  /** Task id → the Claude session working on it, for tasks with a live claim. */
  claims: Record<string, string>
  /** Starts a Claude session on the task (or one todo) in `dir`; resolves to a status message, `notify`ing progress. */
  onLaunch(task: Task, item: TodoItem | undefined, dir: string, notify: (message: string) => void): Promise<string>
  onReloadConfig(): LoadedConfig
  onQuit(): void
}

type Pane = 'list' | 'detail' | 'todo' | 'open'
type EditTarget = 'title' | 'tags' | 'todo-text' | 'todo-add' | 'new-task' | 'update' | 'launch-dir' | 'search' | 'command'
type Mode =
  | { kind: 'normal' }
  | { kind: 'edit'; target: EditTarget; ordinal?: number }
  | { kind: 'confirm'; task: Task }
  | { kind: 'status'; cursor: number }

/** Per-task view state; moving to another task starts from a fresh one. */
interface View { taskId?: string; todoCursor: number; scroll: number; openScroll: number; drilled: boolean }
const freshView = (taskId?: string): View => ({ taskId, todoCursor: 0, scroll: 0, openScroll: 0, drilled: false })

interface Message { text: string; error?: boolean }

const HINTS: [Action, string][] = [
  ['todo-done', 'done'], ['todo-start', 'start'], ['todo-add', 'add'], ['todo-delete', 'del'],
  ['todo-open', 'open'], ['status-pick', 'status'], ['update-add', 'update'], ['claude-todo', 'claude'], ['rename', 'rename'], ['edit-tags', 'tags'], ['task-new', 'new'],
  ['edit-file', 'edit'], ['search', 'search'], ['command', 'cmd'], ['toggle-done', 'done'], ['quit', 'quit'],
]

/** Generated from the live keymap, so a rebind is reflected rather than going stale. */
function hintLine(keys: Keymap, drilled: boolean): Line {
  const segs: Line = []
  for (const [action, text] of HINTS) {
    const shown = drilled && action === 'todo-open' ? 'todo-close' : action
    const key = keyFor(keys, shown)
    if (!key) continue
    segs.push({ text: key, color: theme.accent }, { text: ` ${shown === 'todo-close' ? 'close' : text}  `, color: theme.dim })
  }
  return segs
}

function configMessage(l: LoadedConfig, ignored: string[]): Message | undefined {
  if (l.error) return { text: `config ${tildify(l.path)}: ${l.error}`, error: true }
  if (ignored.length) return { text: `config: ignored bindings ${ignored.join(', ')}`, error: true }
  return undefined
}

export function App(props: AppProps) {
  const { tasks, config, cols, rows, ops } = props
  const ui = config.config.ui
  const { keys, ignored } = useMemo(() => buildKeymap(config.config.keys), [config])
  const [filter, setFilter] = useState('')
  // Session state, seeded from `hide-done`; a config reload that changes the setting re-seeds it.
  const [hideDone, setHideDone] = useState(ui.hideDone)
  useEffect(() => setHideDone(ui.hideDone), [ui.hideDone])
  const [pane, setPane] = useState<Pane>('list')
  const [mode, setMode] = useState<Mode>({ kind: 'normal' })
  const [message, setMessage] = useState<Message | undefined>(() => configMessage(config, ignored))
  const [pendingId, setPendingId] = useState<string>()
  const [pendingKeys, setPendingKeys] = useState('')
  const pendingRef = useRef('')
  const savedFilter = useRef('')
  const editor = useLineEditor()

  const list = useMemo(() => listView(tasks, { hideDone, query: filter }), [tasks, hideDone, filter])
  const { shown, hits } = list
  const visible = useMemo(() => hits.map((h) => h.task), [hits])
  const selection = useSelection(visible)
  const task = selection.task

  const [viewState, setViewState] = useState<View>(() => freshView(task?.id))
  const view = viewState.taskId === task?.id ? viewState : freshView(task?.id)
  const patchView = (patch: Partial<View>) =>
    setViewState((prev) => ({ ...(prev.taskId === task?.id ? prev : freshView(task?.id)), ...patch }))

  // Clamp on every render: a selection can outlive the task it was made in.
  const todos = task?.todos ?? []
  const cursor = clamp(view.todoCursor, 0, Math.max(0, todos.length - 1))
  const current = todos[cursor]
  const drilled = view.drilled && current !== undefined
  const focus: Pane = pane === 'open' && !drilled ? 'todo' : pane
  const panes: Pane[] = drilled ? ['list', 'detail', 'todo', 'open'] : ['list', 'detail', 'todo']
  const layout = computeLayout(ui, cols, rows, drilled)
  const editing = mode.kind === 'edit' ? mode.target : undefined

  useEffect(() => {
    if (pendingId && visible.some((t) => t.id === pendingId)) {
      selection.select(pendingId)
      setPendingId(undefined)
    }
  }, [pendingId, visible])

  const editLine = (prefix: string, width: number): Line =>
    inputLine([{ text: prefix, color: theme.accent }], editor.value, editor.cursor, width)

  const dLines = task
    ? detailLines(task, layout.mainW, ui.showDate, {
        title: editing === 'title' ? editLine('title ', layout.mainW) : undefined,
        tags: editing === 'tags' ? editLine('tags ', layout.mainW) : undefined,
      })
    : [[{ text: 'no task selected', color: theme.faint }]]
  const dScrollMax = Math.max(0, dLines.length - layout.detailRows)
  const scroll = clamp(view.scroll, 0, dScrollMax)

  const editFileKey = keyFor(keys, 'edit-file')
  const oRows = layout.bodyH - 2
  const oLines = drilled ? openLines(current, layout.openW, editFileKey ? `${editFileKey} opens the file` : 'edit the file') : []
  const oScrollMax = Math.max(0, oLines.length - oRows)
  const openScroll = clamp(view.openScroll, 0, oScrollMax)

  // The list and the todo list have no scroll state of their own: they track their cursor.
  const listStart = useRef(0)
  listStart.current = follow(listStart.current, selection.index, layout.listRows, visible.length)
  const todoStart = useRef({ taskId: task?.id, start: 0 })
  if (todoStart.current.taskId !== task?.id) todoStart.current = { taskId: task?.id, start: 0 }
  const adding = editing === 'todo-add'
  todoStart.current.start = follow(todoStart.current.start, adding ? todos.length : cursor, layout.todoRows, todos.length + (adding ? 1 : 0))

  const fail = (what: string) => (e: unknown) => setMessage({ text: `${what}: ${firstLine(e)}`, error: true })
  const run = (what: string, fn: () => void) => {
    try { fn() } catch (e) { fail(what)(e) }
  }

  const startEdit = (target: EditTarget, value: string, ordinal?: number) => {
    editor.start(value)
    setMode({ kind: 'edit', target, ordinal })
  }

  /** Each pane's cursor or scroll offset, its last valid value, and how to move it. */
  const nav: Record<Pane, { at: number; last: number; go(to: number): void }> = {
    list: { at: selection.index, last: visible.length - 1, go: selection.moveTo },
    detail: { at: scroll, last: dScrollMax, go: (to) => patchView({ scroll: to }) },
    todo: { at: cursor, last: todos.length - 1, go: (to) => patchView({ todoCursor: to, openScroll: 0 }) },
    open: { at: openScroll, last: oScrollMax, go: (to) => patchView({ openScroll: to }) },
  }
  const move = (target: Pane, to: (at: number, last: number) => number) => {
    const n = nav[target]
    if (n.last >= 0) n.go(clamp(to(n.at, n.last), 0, n.last))
  }

  const toggle = (state: TodoState) => {
    if (!task || !current) return
    run(state, () => ops.setTodoState(task, current.ordinal, current.state === state ? 'pending' : state))
  }

  /** Reports the widths actually applied, so a knob that had no effect says so. */
  const reportConfig = (l: LoadedConfig) => {
    const lay = computeLayout(l.config.ui, cols, rows, drilled)
    const widths = `list ${lay.listPane} · main ${lay.mainPane}${drilled ? ` · todo ${lay.openPane}` : ''}`
    setMessage(configMessage(l, buildKeymap(l.config.keys).ignored) ?? { text: `config reloaded — ${widths}` })
  }

  /** From the TUI, a person is typing — agents write updates through the CLI. */
  const addHumanUpdate = (target: Task, text: string) =>
    run('update', () => {
      ops.addUpdate(target, text, 'human')
      setMessage({ text: `update added to ${target.id}` })
    })

  const launchClaude = (target: Task, item: TodoItem | undefined, dir: string) => {
    setMessage({ text: `starting Claude on ${item ? `${target.id} #${item.ordinal}` : target.id}…` })
    props.onLaunch(target, item, dir, (text) => setMessage({ text })).then(
      (text) => setMessage({ text }),
      fail('claude'),
    )
  }

  const setTaskStatus = (status: TaskStatus) => {
    if (!task) return
    run('status', () => {
      ops.setStatus(task, status)
      if (status === 'done' && hideDone && task.status !== 'done') {
        // It vanishes from the list under the cursor; say where it went.
        const key = keyFor(keys, 'toggle-done')
        setMessage({ text: `${task.id} done — hidden${key ? ` (${key} shows done tasks)` : ''}` })
      }
    })
  }

  function dispatch(action: Action) {
    const direct = statusOfAction(action)
    if (direct) return setTaskStatus(direct)
    switch (action) {
      case 'status-pick':
        if (task) setMode({ kind: 'status', cursor: TASK_STATUSES.indexOf(task.status) })
        return
      case 'pane-left':
      case 'pane-right': {
        const i = panes.indexOf(focus) + (action === 'pane-left' ? -1 : 1)
        setPane(panes[clamp(i, 0, panes.length - 1)])
        return
      }
      case 'pane-next':
      case 'pane-prev': {
        const i = panes.indexOf(focus) + (action === 'pane-prev' ? -1 : 1)
        setPane(panes[(i + panes.length) % panes.length])
        return
      }
      case 'move-down': return move(focus, (at) => at + 1)
      case 'move-up': return move(focus, (at) => at - 1)
      case 'move-top': return move(focus, () => 0)
      case 'move-bottom': return move(focus, (_, last) => last)
      case 'todo-down': return move('todo', (at) => at + 1)
      case 'todo-up': return move('todo', (at) => at - 1)
      case 'todo-done': return toggle('done')
      case 'todo-start': return toggle('in-progress')
      case 'todo-add':
        if (task) startEdit('todo-add', '')
        return
      case 'todo-delete':
        if (task && current) run('delete', () => ops.removeTodo(task, current.ordinal))
        return
      case 'todo-open':
        if (current) {
          patchView({ drilled: true, openScroll: 0 })
          setPane('open')
        }
        return
      case 'todo-close':
        if (drilled) {
          patchView({ drilled: false })
          if (focus === 'open') setPane('todo')
        } else if (filter) {
          setFilter('')
        }
        return
      case 'task-new': return startEdit('new-task', '')
      case 'task-delete':
        if (task) setMode({ kind: 'confirm', task })
        return
      case 'rename':
        if ((focus === 'todo' || focus === 'open') && current) {
          startEdit('todo-text', current.text, current.ordinal)
        } else if (task) {
          patchView({ scroll: 0 })
          startEdit('title', task.title)
        }
        return
      case 'edit-tags':
        if (task) {
          patchView({ scroll: 0 })
          startEdit('tags', task.tags.join(' '))
        }
        return
      case 'edit-file':
        if (task) props.onEditFile(task.file).catch(fail('edit'))
        return
      case 'search':
        savedFilter.current = filter
        return startEdit('search', filter)
      case 'command': return startEdit('command', '')
      case 'config-edit':
        props.onEditConfig().then(reportConfig, fail('config'))
        return
      case 'config-reload': return reportConfig(props.onReloadConfig())
      case 'update-add':
        if (task) startEdit('update', '')
        return
      case 'claude-todo':
      case 'claude-task': {
        if (!task) return
        const item = action === 'claude-todo' ? current : undefined
        if (action === 'claude-todo' && !item) return setMessage({ text: `no todo selected — ${keyFor(keys, 'claude-task') ?? 'claude-task'} works on the whole task` })
        const holder = props.claims[task.id]
        if (holder) return setMessage({ text: `${task.id} is already being worked on by session ${shortSession(holder)}`, error: true })
        const dir = task.dir ? resolveProjectDir(task.dir) : undefined
        if (dir) return launchClaude(task, item, dir)
        // No usable project dir yet: ask for one, save it to the task, then launch.
        return startEdit('launch-dir', task.dir ?? '', item?.ordinal)
      }
      case 'update-edit':
        if (task) {
          props.onComposeUpdate(task).then(
            (text) => (text ? addHumanUpdate(task, text) : setMessage({ text: 'no update — nothing was written' })),
            fail('update'),
          )
        }
        return
      case 'toggle-done':
        setHideDone(!hideDone)
        setMessage({ text: hideDone ? `showing ${list.done} done` : `hiding ${list.done} done` })
        return
      case 'quit': return props.onQuit()
    }
  }

  function runCommand(input: string) {
    const cmd = parseCommand(input)
    switch (cmd.kind) {
      case 'none': return
      case 'error': return setMessage({ text: cmd.message, error: true })
      case 'quit': return props.onQuit()
      case 'reload': return reportConfig(props.onReloadConfig())
      case 'status':
        setTaskStatus(cmd.status)
        return
      case 'todo':
        if (task && current) run(cmd.state, () => ops.setTodoState(task, current.ordinal, cmd.state))
        return
    }
  }

  /** An empty commit is a no-op everywhere — `dd` and `D` are how you delete. */
  function commit(target: EditTarget, ordinal: number | undefined, raw: string) {
    const value = raw.trim()
    if (target === 'search') return setFilter(value)
    if (target === 'command') return runCommand(value)
    if (!value) return
    if (target === 'new-task') {
      // Only trailing #tags come off the title; renaming deliberately does not do this.
      const { title, tags } = splitTrailingTags(value)
      return run('new', () => {
        const created = ops.createTask({ title, tags })
        setFilter('')
        setPane('list')
        setPendingId(created.id)
      })
    }
    if (!task) return
    switch (target) {
      case 'title':
        if (value !== task.title) run('rename', () => ops.setTitle(task, value))
        return
      case 'tags': {
        const next = normalizeTags([value])
        if (next.join(' ') !== task.tags.join(' ')) run('tags', () => ops.setTags(task, next))
        return
      }
      case 'todo-text': {
        const item = todos.find((t) => t.ordinal === ordinal)
        if (item && value !== item.text) run('rename', () => ops.setTodoText(task, item.ordinal, value))
        return
      }
      case 'update':
        return addHumanUpdate(task, value)
      case 'launch-dir': {
        const dir = resolveProjectDir(value)
        if (!dir) return setMessage({ text: `not a directory: ${value}`, error: true })
        const item = ordinal === undefined ? undefined : todos.find((t) => t.ordinal === ordinal)
        return run('dir', () => {
          ops.setDir(task, dir)
          launchClaude(task, item, dir)
        })
      }
      case 'todo-add':
        run('add', () => ops.addTodo(task, value))
        patchView({ todoCursor: todos.length })
    }
  }

  useInput((input, key) => {
    setMessage(undefined)

    if (mode.kind === 'status') {
      const name = keyName(input, key)
      const close = () => setMode({ kind: 'normal' })
      const pick = (status: TaskStatus) => {
        close()
        setTaskStatus(status)
      }
      if (/^[1-9]$/.test(name) && Number(name) <= TASK_STATUSES.length) return pick(TASK_STATUSES[Number(name) - 1])
      if (name === 'enter') return pick(TASK_STATUSES[mode.cursor])
      if (name === 'esc') return close()
      // Movement follows the live keymap, so rebinding j/k carries over into the picker.
      const { action } = resolveKey(keys, '', name)
      const last = TASK_STATUSES.length - 1
      if (action === 'status-pick') close()
      else if (action === 'move-down' || action === 'todo-down') setMode({ kind: 'status', cursor: Math.min(last, mode.cursor + 1) })
      else if (action === 'move-up' || action === 'todo-up') setMode({ kind: 'status', cursor: Math.max(0, mode.cursor - 1) })
      else if (action === 'move-bottom') setMode({ kind: 'status', cursor: last })
      return
    }

    if (mode.kind === 'confirm') {
      setMode({ kind: 'normal' })
      if (input === 'y' || input === 'Y') {
        const doomed = mode.task
        run('delete', () => {
          ops.deleteTask(doomed)
          setMessage({ text: `deleted ${doomed.id} ${doomed.title}` })
        })
      }
      return
    }

    if (mode.kind === 'edit') {
      const result = editor.handle(input, key)
      if (result === 'commit') {
        setMode({ kind: 'normal' })
        commit(mode.target, mode.ordinal, editor.current().value)
      } else if (result === 'cancel') {
        if (mode.target === 'search') setFilter(savedFilter.current)
        setMode({ kind: 'normal' })
      } else if (result === 'change' && mode.target === 'search') {
        setFilter(editor.current().value.trim())
      }
      return
    }

    // A multi-character chunk (a paste, or keys batched by a slow link) is fed key by key.
    const names = !key.ctrl && !key.meta && input.length > 1 ? Array.from(input) : [keyName(input, key)]
    for (const name of names) {
      const r = resolveKey(keys, pendingRef.current, name)
      pendingRef.current = r.pending
      if (r.action) dispatch(r.action)
    }
    setPendingKeys(pendingRef.current)
  })

  const header = spread(
    [{ text: ' knot ', color: theme.bg, bg: theme.accent, bold: true }, { text: `  ${tildify(props.vault)}`, color: theme.dim }],
    [
      { text: `${filter ? `${visible.length}/` : ''}${shown.length} ${shown.length === 1 ? 'task' : 'tasks'}`, color: theme.dim },
      ...(list.hidden ? [{ text: ` · ${list.hidden} done hidden`, color: theme.dim }] : []),
      ...(list.errors ? [{ text: ` · ${list.errors} unparseable`, color: theme.error }] : []),
      { text: ' ' },
    ],
    cols,
  )

  const prompt = (prefix: string, hint: string): Line =>
    spread(editLine(prefix, cols - hint.length - 1), [{ text: hint, color: theme.faint }], cols)

  let status: Line
  if (mode.kind === 'confirm') {
    status = [{ text: ` delete ${mode.task.id} “${mode.task.title}”? `, color: theme.error, bold: true }, { text: 'y/n', color: theme.fg }]
  } else if (mode.kind === 'status') {
    const move = [keyFor(keys, 'move-down'), keyFor(keys, 'move-up')].filter(Boolean).join('/')
    status = [
      { text: ` 1–${TASK_STATUSES.length}`, color: theme.accent }, { text: ' pick  ', color: theme.dim },
      ...(move ? [{ text: move, color: theme.accent }, { text: ' move  ', color: theme.dim }] : []),
      { text: 'enter', color: theme.accent }, { text: ' set  ', color: theme.dim },
      { text: 'esc', color: theme.accent }, { text: ' cancel', color: theme.dim },
    ]
  } else if (editing === 'search') {
    status = editLine(' /', cols)
  } else if (editing === 'command') {
    status = editLine(' :', cols)
  } else if (editing === 'launch-dir') {
    status = prompt(` project dir for ${task?.id ?? ''} `, 'Claude works there · saved to the task ')
  } else if (editing === 'update') {
    const composeKey = keyFor(keys, 'update-edit')
    status = prompt(` update ${task?.id ?? ''} `, composeKey ? `esc, then ${composeKey} for a longer one in $EDITOR ` : '')
  } else if (editing === 'new-task') {
    status = prompt(' new task ', 'trailing #tags tag it ')
  } else if (editing) {
    status = [{ text: ' enter', color: theme.accent }, { text: ' save  ', color: theme.dim }, { text: 'esc', color: theme.accent }, { text: ' cancel', color: theme.dim }]
  } else if (message) {
    status = [{ text: ` ${message.text}`, color: message.error ? theme.error : theme.fg }]
  } else {
    // The unlabelled panes show their scroll position here, since a label row would eat a content line.
    const scrollPos = focus === 'detail' ? position(scroll, layout.detailRows, dLines.length)
      : focus === 'open' ? position(openScroll, oRows, oLines.length) : ''
    const right = [pendingKeys, scrollPos].filter(Boolean).join('  ')
    status = spread([{ text: ' ' }, ...hintLine(keys, drilled)], [{ text: `${right} `, color: theme.dim }], cols)
  }

  const addKey = keyFor(keys, 'todo-add')
  const showDoneKey = keyFor(keys, 'toggle-done')
  const emptyList = filter && shown.length ? `no match for /${filter}`
    : list.hidden && !shown.length ? `all ${list.hidden} done hidden${showDoneKey ? ` — ${showDoneKey} shows them` : ''}`
    : 'no tasks yet'
  const inputW = layout.mainW - 3
  return (
    <Box flexDirection="column" width={cols} height={rows} backgroundColor={theme.bg}>
      <Row line={truncateLine(header, cols)} />
      <Box flexDirection="row" height={layout.bodyH}>
        <TaskList
          hits={hits}
          empty={emptyList}
          claims={props.claims}
          index={selection.index}
          start={listStart.current}
          rows={layout.listRows}
          width={layout.listW}
          paneWidth={layout.listPane}
          height={layout.bodyH}
          focused={focus === 'list'}
          labels={ui.paneLabels}
          filter={filter}
        />
        <Box flexDirection="column" width={layout.mainPane} flexShrink={0}>
          <ScrollPane
            lines={dLines}
            scroll={scroll}
            rows={layout.detailRows}
            width={layout.mainPane}
            height={layout.detailPaneH}
            focused={focus === 'detail'}
          />
          <TodoPane
            todos={todos}
            cursor={cursor}
            start={todoStart.current.start}
            rows={layout.todoRows}
            width={layout.mainW}
            paneWidth={layout.mainPane}
            height={layout.todoPaneH}
            focused={focus === 'todo'}
            drilled={drilled}
            labels={ui.paneLabels}
            progress={task ? progress(task) : { done: 0, total: 0 }}
            editing={editing === 'todo-text' ? inputLine([], editor.value, editor.cursor, inputW) : undefined}
            adding={adding ? inputLine([], editor.value, editor.cursor, inputW) : undefined}
            emptyHint={task ? `no todos${addKey ? ` — ${addKey} adds one` : ''}` : ''}
          />
        </Box>
        {drilled && (
          <ScrollPane
            lines={oLines}
            scroll={openScroll}
            rows={oRows}
            width={layout.openPane}
            height={layout.bodyH}
            focused={focus === 'open'}
          />
        )}
      </Box>
      <Row line={truncateLine(status, cols)} />
      {mode.kind === 'status' && task && (
        <StatusPicker current={task.status} cursor={mode.cursor} top={2} left={layout.listPane + 2} />
      )}
    </Box>
  )
}
