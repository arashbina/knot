# knot

A task manager whose tasks are plain markdown files, shared by you and your coding agents. Agents claim tasks, tick todos off and log what they did through a CLI; you work in a terminal UI, in Obsidian or in any editor, on the same files. knot only ever rewrites the lines it changes, so nothing you wrote by hand gets reformatted.

```
 knot   ~/notes/tasks                                                                      4 tasks
╭────────────────────────────────────╮╭────────────────────────────────────────────────────────────╮
│ TASKS                          1/4 ││ t-001  WIP  2026-09-28 19:50  #welcome                     │
│ ▌Welcome to knot: start here       ││                                                            │
│ ▌WIP  0/11  #welcome               ││ Work down the todos below to learn the keys: each one      │
│  Fix the login redirect that drop… ││ teaches a key or two, and enter opens it to read more.     │
│  BLOCK  #bug                       ││                                                            │
│  Draft the quarterly plan          ││ Every task is a plain markdown file in the folder shown at │
│  BACKLOG  0/2  #planning           ││ the top: a title, a status and tags, a description like    │
│  Tidy the release checklist        ││ this one, a checklist of todos and a log of updates. This  │
│  DONE                              ││ TUI, the knot CLI and any editor, Obsidian included, work  │
│                                    ││ on the same files; the web viewer shows them read-only.    │
│                                    │╰────────────────────────────────────────────────────────────╯
│                                    │╭────────────────────────────────────────────────────────────╮
│                                    ││ TODO  0/11                                          1–7/11 │
│                                    ││ ▌○ J/K walk todos, tab panes ›                             │
│                                    ││  ○ enter opens a todo's detail ›                           │
│                                    ││  ○ space starts a todo, x ends it ›                        │
│                                    ││  ○ o adds a todo, dd deletes one ›                         │
│                                    ││  ○ s sets the task's status ›                              │
│                                    ││  ○ u writes an update ›                                    │
│                                    ││  ○ i renames, t tags, e edits ›                            │
╰────────────────────────────────────╯╰────────────────────────────────────────────────────────────╯
 x done  space start  o add  dd del  enter open  s status  u update  c claude  i rename  t tags  …
```

## Why knot

- **Your files stay yours.** Each task is one markdown file in a folder (the *vault*): frontmatter for the title, status and tags, then a description, a `## Todo` checklist and an `## Updates` log. Edits change only the lines they touch: marking a todo done flips one character (and bumps `updated:`), and comments, callouts and unknown frontmatter survive.
- **Built for coding agents.** The `knot` CLI never prompts, answers reads in JSON with `--json`, and uses stable exit codes. A skill for Claude Code teaches Claude to claim a task, work through its todos and leave updates for the next reader.
- **Safe with several sessions at once.** A claim ties a task to the Claude session working on it. Another session is refused (exit 3) while that one is alive, and a session that exits frees its claim, with no timeouts. (A claim made on another machine, in a synced vault, can't be checked and stays until `knot release <id> --force`.)
- **One vault across projects.** A task can name the project folder its work happens in; from the TUI, `c` starts Claude on the selected todo right there (in a split pane when you run inside [herdr](https://herdr.dev)).
- **A read-only web viewer** for looking at the same vault in a browser.

## Status and requirements

Early and pre-1.0: the file format, CLI and config may still change. knot isn't on npm yet (it will be published as `knot-tui`), so you run it from a checkout.

- Node.js 22.15 or newer
- macOS, where it's developed and tested; Linux should work (it needs `ps` and `/bin/sh`). Native Windows isn't supported.
- Optional: [Claude Code](https://code.claude.com/docs/en/overview), [Obsidian](https://obsidian.md), herdr

## Install

```sh
git clone https://github.com/arashbina/knot.git
cd knot
npm ci
mkdir -p ~/.local/bin
ln -s "$PWD/bin/knot" ~/.local/bin/knot   # or any other folder on your PATH
knot help
```

If `knot` isn't found, add that folder to your PATH, e.g. `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`, and open a new shell.

## Quick start

Keep your tasks outside the checkout. The default vault is `tasks/` inside it, which is gitignored, so `git clean -x` or a fresh clone would lose it.

```sh
mkdir -p ~/notes/tasks
knot config init        # writes ~/.config/knot/config.toml
```

In `~/.config/knot/config.toml`, uncomment the `dir` line under `[vault]` so it reads:

```toml
[vault]
dir = "~/notes/tasks"
```

Then open the terminal UI from the checkout:

```sh
npm run tui
```

On first launch an empty vault gets a welcome task. Its todos walk you through the keys: work down them and delete the task when you're done.

From the CLI:

```sh
knot new "Fix timezone bug in weekly report" --tag bug <<'EOF'
Weekly reports for users east of UTC start a day early.

## Todo

- [ ] Reproduce with a failing test
    `src/reports/week.ts:40` uses the server's zone.
- [ ] Compute week boundaries in the user's zone
EOF
knot list
knot show t-002         # t-001 is the welcome task
knot todo done t-002 1
knot next t-002 --json
```

`knot new` prints the new task's id.

`knot help` lists every command. Long text always goes on stdin (a quoted heredoc keeps backticks and `$` intact). Exit codes: `0` ok, `1` usage, `2` not found or any other error, `3` another session holds the task.

## A task file

```markdown
---
id: t-001
title: Fix timezone bug in weekly report
status: in-progress
tags: [bug]
dir: /Users/you/code/app
created: 2026-09-28T10:00:00.000Z
updated: 2026-09-28T11:30:00.000Z
---

Weekly reports for users east of UTC start a day early.

## Todo

- [x] Reproduce with a failing test
    `src/reports/week.ts:40` uses the server's zone.
- [/] Compute week boundaries in the user's zone
- [ ] Ship it

## Updates

### 2026-09-28 11:30 — agent

Test added and failing as expected; fixing the boundary next.
```

knot keeps runtime state (which session holds which task, which ids were used) in a hidden `.knot/` folder in the vault; it isn't task content.

Statuses are `backlog`, `in-progress`, `review`, `done` and `blocked`. Todo markers are `[ ]` pending, `[/]` in progress, `[x]` done and `[-]` cancelled. Indented lines under a todo are its detail: the context someone needs to do it. `dir:` is optional.

## Working with Claude Code

From the checkout, link the skill so Claude can use knot from any repo:

```sh
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/knot" ~/.claude/skills/knot
```

Then ask Claude to "work on t-002", or "do todo 2 of t-002". It claims the task, sets it in progress, works through the todos, ticks them off with notes for the next reader, then sets the task to `review` (never `done`; that's yours) and releases the claim.

In the TUI, `c` starts Claude on the selected todo and `C` on the whole task, in the task's `dir:` (asked for once if the task has none). This needs `claude` and `knot` on your PATH and the skill linked. Claims only block edits from other Claude sessions: at your own terminal every edit goes through, and taking over or releasing a live claim needs `--force`.

## Using it with Obsidian

Point the vault at a subfolder of your Obsidian vault, never its root, or every note would load as a task. knot handles what Obsidian does to these files (tab indents, the Properties editor rewriting tags as a list). Core Obsidian knows only `[ ]` and `[x]`: clicking a `[/]` or `[-]` there flattens it, while the Tasks plugin knows all four markers. Tags are read from frontmatter only, not from inline `#tags`.

## Web viewer

```sh
npm run web             # http://127.0.0.1:3000
```

If port 3000 is busy, Next picks the next free one and prints it.

It shows the same list and tasks as the TUI and updates live. It's read-only and has no authentication: keep it on 127.0.0.1.

## Configuration

The config file is `~/.config/knot/config.toml` (or `$XDG_CONFIG_HOME/knot/config.toml`); `knot config init` writes a commented default with every key, and `knot config show` prints what's in effect. The TUI's `ctrl+e` opens it.

The vault is the first of: `$KNOT_DIR`, the config's `[vault] dir`, then the `tasks/` folder in the checkout. Set `KNOT_AUTHOR=human` when you pipe an update in yourself: piped updates are otherwise credited to an agent.

## Development

```sh
npm run typecheck
npm test                # unit and CLI integration tests
npm run check           # TUI behaviour checks through a headless harness
npm run smoke           # web end to end (builds the viewer)
```

## License

[MIT](LICENSE)
