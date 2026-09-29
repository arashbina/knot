import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'smol-toml'
import { firstLine } from './parse.js'

export interface UiConfig {
  listWidth: number
  detailShare: number
  detailHeight: number
  minDetail: number
  maxTodo: number
  paneLabels: boolean
  showDate: boolean
  hideDone: boolean
}

export interface Config {
  ui: UiConfig
  /** Raw `[keys.normal]` overrides, key name → action name. The TUI validates actions. */
  keys: Record<string, string>
  vault: { dir?: string }
  editor: { command?: string }
  /** Claude sessions launched from the TUI. */
  claude: {
    /** When a todo goes to the task's already-open session: `/clear` it first, or keep its context. */
    clearBetweenTodos: boolean
  }
}

export interface LoadedConfig { config: Config; path: string; error?: string }

export const DEFAULT_UI: UiConfig = {
  listWidth: 38,     // fixed width of the task list pane, borders included
  detailShare: 0.55, // the middle column's share of the width once a todo is opened
  detailHeight: 0.55, // detail's share of its column's height
  minDetail: 30,     // floor for the middle column while a todo is open; 0 disables
  maxTodo: 0,        // ceiling for the opened-todo pane; 0 disables
  paneLabels: true,  // TASKS / TODO headers; the detail pane never has one
  showDate: true,    // `updated` in the detail meta line, space permitting
  hideDone: false,   // start the TUI with done tasks hidden; `toggle-done` flips it
}

/** Each `[ui]` setting's TOML name and what counts as valid, in the order `knot config show` prints them. */
export const UI_FIELDS: Record<keyof UiConfig, { name: string; valid: (v: unknown) => boolean }> = {
  listWidth: { name: 'list-width', valid: (v) => Number.isInteger(v) && (v as number) >= 12 },
  detailShare: { name: 'detail-share', valid: (v) => typeof v === 'number' && v > 0 && v < 1 },
  detailHeight: { name: 'detail-height', valid: (v) => typeof v === 'number' && v > 0 && v < 1 },
  minDetail: { name: 'min-detail', valid: (v) => Number.isInteger(v) && (v as number) >= 0 },
  maxTodo: { name: 'max-todo', valid: (v) => Number.isInteger(v) && (v as number) >= 0 },
  paneLabels: { name: 'pane-labels', valid: (v) => typeof v === 'boolean' },
  showDate: { name: 'show-date', valid: (v) => typeof v === 'boolean' },
  hideDone: { name: 'hide-done', valid: (v) => typeof v === 'boolean' },
}

export const DEFAULT_CONFIG_TEXT = `# knot configuration.
# Every key is optional: anything missing or invalid falls back to the default
# shown here, one key at a time, so a partial file is fine.

[vault]
# Folder of task markdown files. \`~\` expands; relative paths resolve against this
# file's directory. $KNOT_DIR overrides it.
# Point it at a subfolder, never at an Obsidian vault root — every note in the
# vault would load as a task.
# dir = "~/notes/tasks"

[editor]
# Command for \`knot edit\` and the TUI's \`e\` / ctrl+e. Wins over $VISUAL / $EDITOR.
# Arguments are fine: the file path is appended.
# command = "code --wait"

[claude]
# Sessions started from the TUI (c = one todo, C = the whole task) belong to the
# task: inside herdr, the next c/C for that task goes to its session if it's still
# open and idle, instead of opening another. true sends /clear first, so each todo
# starts with a fresh context; false keeps the conversation going.
# clear-between-todos = false

[ui]
# list-width = 38      # fixed width of the task list pane, borders included
# detail-share = 0.55  # middle column's share of the width once a todo is opened
# detail-height = 0.55 # detail pane's share of its column's height
# min-detail = 30      # floor for the middle column while a todo is open; 0 disables
# max-todo = 0         # ceiling for the opened-todo pane; 0 disables.
#                      # A non-zero cap wins over detail-share on wide terminals.
# pane-labels = true   # TASKS / TODO header rows
# show-date = true     # show \`updated\` in the detail meta line when it fits
# hide-done = false    # start with done tasks hidden (H toggles them in the TUI)

[keys.normal]
# key = "action". Bindings merge over the defaults; key = "" unbinds a default.
# Key names: a literal character (case matters), or space, tab, shift+tab, enter,
# esc, backspace, up, down, left, right, ctrl+<char>. Sequences are just longer
# names, e.g. "gg". Ctrl-H and Ctrl-J can never be bound: terminals send them as
# backspace and enter.
# Actions: pane-left pane-right pane-next pane-prev move-down move-up move-top
#   move-bottom todo-down todo-up todo-done todo-start todo-add todo-delete
#   todo-open todo-close task-new task-delete rename edit-tags edit-file search
#   command config-edit config-reload quit status-pick toggle-done update-add
#   update-edit claude-todo claude-task
# Set a status directly, skipping the picker (unbound by default): status-backlog
#   status-in-progress status-review status-done status-blocked
# "ctrl+d" = "todo-delete"
# x = ""
# W = "status-in-progress"
# B = "status-blocked"
`

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** `expandHome` in reverse, for showing a path. */
export function tildify(p: string): string {
  const home = os.homedir()
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p
}

/** A project directory as typed: `~` expanded, made absolute against `cwd`. Undefined unless it exists. */
export function resolveProjectDir(value: string, cwd = process.cwd()): string | undefined {
  const dir = path.resolve(cwd, expandHome(value.trim()))
  return value.trim() && fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? dir : undefined
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KNOT_CONFIG) return path.resolve(expandHome(env.KNOT_CONFIG))
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, 'knot', 'config.toml')
}

export function defaultConfig(): Config {
  return { ui: { ...DEFAULT_UI }, keys: {}, vault: {}, editor: {}, claude: { clearBetweenTodos: false } }
}

function table(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Never throws — the same contract as `parseTask`. A missing file is not an error. */
export function loadConfig(file = configPath()): LoadedConfig {
  const config = defaultConfig()
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT'
    return missing ? { config, path: file } : { config, path: file, error: firstLine(e) }
  }
  let doc: Record<string, unknown>
  try { doc = parse(text) as Record<string, unknown> }
  catch (e) { return { config, path: file, error: firstLine(e) } }

  const ui = table(doc.ui)
  for (const [key, field] of Object.entries(UI_FIELDS)) {
    const v = ui[field.name]
    if (v !== undefined && field.valid(v)) (config.ui as unknown as Record<string, unknown>)[key] = v
  }
  for (const [k, v] of Object.entries(table(table(doc.keys).normal))) {
    if (typeof v === 'string') config.keys[k] = v
  }
  const dir = table(doc.vault).dir
  if (typeof dir === 'string' && dir.trim()) {
    config.vault.dir = path.resolve(path.dirname(file), expandHome(dir.trim()))
  }
  const command = table(doc.editor).command
  if (typeof command === 'string' && command.trim()) config.editor.command = command.trim()
  const clear = table(doc.claude)['clear-between-todos']
  if (typeof clear === 'boolean') config.claude.clearBetweenTodos = clear
  return { config, path: file }
}

/** Writes the commented default file; never clobbers an existing one. */
export function initConfig(file = configPath()): { path: string; created: boolean } {
  if (fs.existsSync(file)) return { path: file, created: false }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, DEFAULT_CONFIG_TEXT, { flag: 'wx' })
  return { path: file, created: true }
}

/**
 * $KNOT_DIR, then `[vault] dir`, then the checkout's `tasks/` (bin/knot exports
 * KNOT_ROOT so this works from any cwd), then `./tasks`.
 */
export function resolveVault(
  loaded: LoadedConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  if (env.KNOT_DIR) return path.resolve(cwd, expandHome(env.KNOT_DIR))
  if (loaded.config.vault.dir) return loaded.config.vault.dir
  if (env.KNOT_ROOT) return path.join(env.KNOT_ROOT, 'tasks')
  return path.resolve(cwd, 'tasks')
}

/** The config's `[editor] command` wins over $VISUAL / $EDITOR, like git's core.editor. */
export function editorCommand(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  return config.editor.command || env.VISUAL || env.EDITOR || 'vi'
}

/** Synchronous on purpose: the caller's stdin reader must not compete with the editor. */
export function spawnEditor(file: string, config: Config): number {
  const result = spawnSync('/bin/sh', ['-c', `${editorCommand(config)} "$1"`, 'sh', file], { stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}
