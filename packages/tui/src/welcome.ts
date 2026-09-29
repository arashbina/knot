import fs from 'node:fs'
import path from 'node:path'
import { createTask, loadAll, openStore, type CreateTaskInput, type LoadedConfig, type Task } from '@knot-tui/core'
import { keyFor, type Action, type Keymap } from './keys.js'

/**
 * The task a new vault starts with. It teaches the TUI by being worked through, so the
 * keys it names come from the keymap it's created with: a config written before the
 * first launch is reflected. Prompts (the status picker, search) only ever take enter
 * and esc, so those are written literally.
 */
export function welcomeTask(keys: Keymap): CreateTaskInput {
  const k = (action: Action) => {
    const key = keyFor(keys, action)
    return key ? `\`${key}\`` : '(unbound)'
  }
  const body = `Work down the todos below to learn the keys: each one teaches a key or two, and ${k('todo-open')} opens it to read more.

Every task is a plain markdown file in the folder shown at the top: a title, a status and tags, a description like this one, a checklist of todos and a log of updates. This TUI, the \`knot\` CLI and any editor, Obsidian included, work on the same files; the web viewer shows them read-only.

A task file looks like this:

\`\`\`markdown
---
title: Ship the release
status: in-progress
tags: [release]
---

Cut 2.0 once the docs land.

## Todo

- [x] Tag the build
- [/] Write the release notes
    Mention the new config keys.
- [ ] Announce it

## Updates
\`\`\`

> Coding agents work on the same files through the \`knot\` CLI (\`bin/knot\` in the knot checkout; \`knot help\` lists its commands). Press ${k('claude-todo')} on a todo of your own to hand it to Claude.`

  return {
    title: 'Welcome to knot: start here',
    status: 'in-progress',
    tags: ['welcome'],
    body,
    todos: [
      {
        text: `${k('todo-down')}/${k('todo-up')} walk todos, ${k('pane-next')} panes`,
        detail: `${k('todo-down')} and ${k('todo-up')} move the todo cursor from any pane, so you rarely need to leave the list. ${k('pane-next')} and ${k('pane-prev')} (or ${k('pane-left')} and ${k('pane-right')}) move between the task list, the description and the todos; in the focused one ${k('move-down')} and ${k('move-up')} move the cursor, and ${k('move-top')} and ${k('move-bottom')} jump to the top and the bottom.`,
      },
      {
        text: `${k('todo-open')} opens a todo's detail`,
        detail: `This is a detail: the indented text under a todo in the file, with the context someone needs to do it. ${k('todo-close')} closes it again.`,
      },
      {
        text: `${k('todo-start')} starts a todo, ${k('todo-done')} ends it`,
        detail: `${k('todo-start')} marks the todo under the cursor in progress and ${k('todo-done')} marks it done; press either again to undo. In the file that flips one character: \`- [ ]\`, \`- [/]\`, \`- [x]\`. The \`:cancel\` command marks a todo cancelled and \`:reset\` clears it.`,
      },
      {
        text: `${k('todo-add')} adds a todo, ${k('todo-delete')} deletes one`,
        detail: `${k('todo-add')} asks for a line of text and adds a todo at the end, with the cursor on it. ${k('todo-delete')} then deletes it, detail and all; there's no undo, so try it on the new one. With the todos focused, ${k('rename')} renames one.`,
      },
      {
        text: `${k('status-pick')} sets the task's status`,
        detail: `A task is backlog, in-progress, review, done or blocked. ${k('status-pick')} opens a picker: press 1 to 5, or move with ${k('move-down')} and ${k('move-up')} and press \`enter\` (\`esc\` cancels). The \`:status review\` command works too, and ${k('toggle-done')} hides and shows done tasks.`,
      },
      {
        text: `${k('update-add')} writes an update`,
        detail: `Updates are the task's log, newest first, under \`## Updates\`. ${k('update-add')} takes one line; ${k('update-edit')} opens your editor for a longer one. Agents leave updates as they work, so this is where you read what they did.`,
      },
      {
        text: `${k('rename')} renames, ${k('edit-tags')} tags, ${k('edit-file')} edits`,
        detail: `With the task list focused, ${k('rename')} renames the task and ${k('edit-tags')} edits its tags. ${k('edit-file')} opens the whole file in your editor (\`[editor] command\` in the config, else $VISUAL or $EDITOR); the list picks up what you save.`,
      },
      {
        text: `${k('task-new')} creates a task of your own`,
        detail: `${k('task-new')} asks for a title and creates the file, and the list selects it; come back to this one to carry on. From a script or an agent it's \`knot new "Title"\`, with a description and a \`## Todo\` section piped on stdin.`,
      },
      {
        text: `${k('search')} searches`,
        detail: `${k('search')} filters the list as you type: titles and tags match fuzzily, descriptions by substring, and \`#welcome\` matches tags only. In the prompt \`enter\` keeps the filter and \`esc\` cancels it; afterwards ${k('todo-close')} clears it.`,
      },
      {
        text: `${k('claude-todo')} hands a todo to Claude`,
        detail: `Try it on a task of your own, not this one: ${k('claude-todo')} starts Claude Code on the todo under the cursor and ${k('claude-task')} on the whole task, in the task's project folder (asked for once, then saved in the file as \`dir:\`). Claude works through the \`knot\` CLI: it claims the task, ticks todos off and writes updates, and the list marks the task while a session is on it. Needs the \`claude\` CLI and the knot skill: link the knot checkout's \`skills/knot\` into \`~/.claude/skills/\`.`,
      },
      {
        text: `${k('task-delete')} deletes this task when done`,
        detail: `It's a task like any other, and it won't come back. ${k('config-edit')} opens the config, where every key can be rebound; ${k('command')} runs commands such as \`:q\`, and ${k('quit')} quits.`,
      },
    ],
  }
}

/**
 * Whether a missing vault may be created on first launch: only the default one. A vault the
 * user named (`$KNOT_DIR`, `[vault] dir`) must exist, so a typo fails loudly; and with a
 * broken config there is no telling whether it named one.
 */
export function mayCreateVault(loaded: LoadedConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.KNOT_DIR && !loaded.config.vault.dir && loaded.error === undefined
}

/**
 * First launch. A vault knot has never used — missing, or with no task files and no
 * `.knot/` — gets the welcome task. `.knot/` marks the vault as used, so deleting
 * the welcome task never brings it back; making it first is also the tie-break between
 * two launches at once. A missing vault is only created with `create` (the default vault,
 * never one the user named: a typo there must fail loudly). Returns the task it created.
 */
export function ensureWelcome(dir: string, keys: Keymap, { create = true } = {}): Task | undefined {
  const vault = path.resolve(dir)
  const stat = fs.statSync(vault, { throwIfNoEntry: false })
  if (stat ? !stat.isDirectory() || loadAll({ dir: vault }).length > 0 : !create) return undefined
  const store = openStore(vault, { create: true })
  try {
    fs.mkdirSync(path.join(vault, '.knot'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw e
  }
  return createTask(store, welcomeTask(keys))
}
