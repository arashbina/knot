import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useApp, useWindowSize } from 'ink'
import {
  addTodo, addUpdate, createTask, deleteTask, initConfig, listClaims, loadAll, loadConfig, removeTodo,
  setDir, setStatus, setTags, setTitle, setTodoState, setTodoText, spawnEditor, watchTasks,
  type LoadedConfig, type Store, type Task, type TodoItem,
} from '@knot-tui/core'
import { App, type Ops } from './App.js'
import { readComposed, updateTemplate } from './compose.js'
import { inHerdr, launchInHerdr, planLaunch, runTakeover, type LaunchPlan } from './launch.js'

export interface RootProps {
  store: Store
  vault: string
  configFile: string
  initialConfig: LoadedConfig
  /** Off in the headless harness, where every write already updates the list synchronously. */
  watch?: boolean
  /** Starts a Claude session; resolves to a status message, `notify`ing progress. The harness records instead. */
  launcher?: (plan: LaunchPlan, notify: (message: string) => void) => Promise<string>
  /**
   * How often claims are re-checked. A session that exits leaves no file event behind,
   * so its marker only clears on the next check.
   */
  claimPollMs?: number
}

/**
 * Owns everything that touches Ink's hooks or the disk: the task list (updated by
 * every write and reloaded on external changes), the config, and the $EDITOR hand-off.
 */
export function Root({ store, vault, configFile, initialConfig, watch = true, launcher, claimPollMs = 3000 }: RootProps) {
  const { exit, suspendTerminal } = useApp()
  const { columns, rows } = useWindowSize()
  const [tasks, setTasks] = useState(() => loadAll(store))
  const [loaded, setLoaded] = useState(initialConfig)
  // task id → the session working on it
  const readClaims = useCallback(() => Object.fromEntries(listClaims(store).map((c) => [c.task, c.session])), [store])
  const [claims, setClaims] = useState<Record<string, string>>(readClaims)
  const refreshClaims = useCallback(() => {
    const next = readClaims()
    setClaims((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
  }, [readClaims])
  useEffect(() => {
    const timer = setInterval(refreshClaims, claimPollMs)
    return () => clearInterval(timer)
  }, [refreshClaims, claimPollMs])

  const reload = useCallback(() => {
    setTasks(loadAll(store))
    refreshClaims()
  }, [store, refreshClaims])

  // An agent writing through the CLI shows up here live.
  useEffect(() => (watch ? watchTasks(store, (next) => {
    setTasks(next)
    refreshClaims()
  }) : undefined), [store, watch, refreshClaims])

  // A write returns its task re-read from the file it just wrote, so only that task is
  // swapped in; the watcher reloads everything soon after anyway. A failed write reloads
  // at once: a stale list is the likely cause, and the next keypress acts on it.
  const ops = useMemo<Ops>(() => {
    const orReload = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
      try { return fn(...args) } catch (e) {
        reload()
        throw e
      }
    }
    const swapIn = <A extends unknown[]>(fn: (...args: A) => Task) => orReload((...args: A) => {
      const task = fn(...args)
      setTasks((prev) => (prev.some((t) => t.file === task.file)
        ? prev.map((t) => (t.file === task.file ? task : t))
        : [...prev, task]))
      return task
    })
    return {
      createTask: swapIn((input) => createTask(store, input)),
      deleteTask: orReload((task) => {
        deleteTask(task)
        setTasks((prev) => prev.filter((t) => t.file !== task.file))
      }),
      setTitle: swapIn(setTitle),
      setTags: swapIn(setTags),
      setStatus: swapIn(setStatus),
      setTodoState: swapIn(setTodoState),
      setTodoText: swapIn(setTodoText),
      addTodo: swapIn(addTodo),
      addUpdate: swapIn(addUpdate),
      setDir: swapIn(setDir),
      removeTodo: swapIn(removeTodo),
    }
  }, [store, reload])

  // Ink 7's suspendTerminal hands the TTY over (raw mode off, input detached) and
  // forces a full redraw on return — the editor may have repainted the screen.
  const edit = (file: string) => suspendTerminal(() => { spawnEditor(file, loaded.config) })

  /** The update text written in $EDITOR, or undefined when the editor exits non-zero. */
  const composeUpdate = async (task: Task): Promise<string | undefined> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-update-'))
    const file = path.join(dir, `${task.id}-update.md`)
    try {
      fs.writeFileSync(file, updateTemplate(task))
      let code = 0
      await suspendTerminal(() => { code = spawnEditor(file, loaded.config) })
      return code === 0 ? readComposed(fs.readFileSync(file, 'utf8')) : undefined
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Inside herdr, a pane beside the TUI; anywhere else, Claude takes over this terminal until it exits. */
  const defaultLauncher = async (plan: LaunchPlan, notify: (message: string) => void): Promise<string> => {
    if (inHerdr()) return launchInHerdr(plan, { notify })
    let code = 0
    await suspendTerminal(() => { code = runTakeover(plan) })
    reload()
    return code === 0 ? `Claude session for ${plan.label} ended` : `claude exited with ${code}`
  }

  const onLaunch = (task: Task, item: TodoItem | undefined, dir: string, notify: (message: string) => void) => {
    const env: Record<string, string> = { KNOT_DIR: vault }
    if (process.env.KNOT_CONFIG) env.KNOT_CONFIG = process.env.KNOT_CONFIG
    const plan = planLaunch(task, item, dir, env, { clearContext: loaded.config.claude.clearBetweenTodos })
    return (launcher ?? defaultLauncher)(plan, notify)
  }

  const onReloadConfig = () => {
    const next = loadConfig(configFile)
    setLoaded(next)
    return next
  }

  return (
    <App
      tasks={tasks}
      vault={vault}
      config={loaded}
      cols={columns}
      rows={rows}
      ops={ops}
      onEditFile={(file) => edit(file).finally(reload)}
      onEditConfig={async () => {
        initConfig(configFile)
        await edit(configFile)
        return onReloadConfig()
      }}
      onComposeUpdate={composeUpdate}
      claims={claims}
      onLaunch={onLaunch}
      onReloadConfig={onReloadConfig}
      onQuit={() => exit()}
    />
  )
}
