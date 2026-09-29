---
name: knot
description: Plan and work through tasks in the knot vault — markdown task files with todos, statuses and progress updates. Use when the user asks to capture or plan work as a knot task (a description plus todos with context), or to work on, continue or pick up a knot task or one of its todos (ids like t-012, "todo 3 of t-012"). While working, keeps todo states, task status and updates current.
allowed-tools: Bash(knot *), Bash(git rev-parse *)
---

# knot

Everything goes through the `knot` CLI on your PATH. It finds the vault itself, so run it from whatever repo you're in. If `knot` isn't found, stop and tell the user: the CLI isn't on their PATH yet (the README's install step symlinks `bin/knot`).

- **Never hand-edit task files.** Every change goes through `knot`: the indentation that binds a detail to its todo is easy to break by hand.
- Pass `--json` on reads and parse it.
- Exit codes: `0` ok · `1` usage · `2` not found (including "nothing left" from `next`) · `3` another session is working on the task. Errors go to stderr: one line, plus a `knot help` hint on usage errors (exit 1).
- Pass long text on stdin with a quoted heredoc (`<<'EOF'`) so the shell leaves backticks and `$` alone. `body` and `todo detail` take their text only there: text as an argument or empty stdin exits 1, and `--clear` is how to empty one. `update` takes its text once, a quoted `-m "text"` or stdin (not both); stray arguments exit 1. An exit-2 error ending in "try again" (another writer was mid-save) is transient: rerun the command once.
- Ordinals are positional: removing a todo renumbers the ones below it. **Re-read before acting on an ordinal** after any removal.

## Creating a task

1. **Gather what the next person needs.** Pull it from the discussion and the code — don't make it up; ask when it's unclear.
   - **Description:** the goal, why it matters, constraints, and what "done" means.
   - **Todos:** concrete steps in order, each small enough to finish and verify on its own.
   - **Each todo's detail — its context:** the files and functions involved (`path:line`), commands to run, decisions already made, gotchas, links, and how to verify the step. Write it so a session with no memory of this conversation could do the step.
   - **The project directory** the work happens in — usually the repo you're in (`git rev-parse --show-toplevel`, else `$PWD`). It's optional, but a Claude session launched from the knot TUI starts there, so include it unless the task isn't about a codebase.
2. **Show the draft and wait for approval.** Show the title, tags, status, project directory, description, and each todo with its detail. Adjust until the user approves; create nothing before that.
3. **Create it in one call.** The body goes on stdin, and a `## Todo` section on stdin becomes the todos, each with its indented detail (4 spaces):

   ```sh
   knot new "Fix timezone bug in weekly report" --tag bug,reports --dir "$(git rev-parse --show-toplevel)" --json <<'EOF'
   Reports for users east of UTC start on Sunday evening: the week boundary is
   computed in server time. Done when the weekly report matches the user's week.

   ## Todo

   - [ ] Reproduce with a failing test in Asia/Tokyo
       `src/reports/week.ts:40` computes `startOfWeek` with the server zone.
       Add the case to `test/reports/week.test.ts`; it should fail today.
   - [ ] Compute the boundaries in the user's zone
       The user's zone is `user.tz` (IANA name). Keep the API signature.
   EOF
   ```

   Status defaults to `backlog`; pass `--status in-progress` only if you're starting it now. Then report the new id. `knot dir <id> <path>` sets or changes the directory later.

## Working on a task

First work out the scope from what the user asked:
- **One todo** ("do todo 3 of t-012", or a todo named by its text): do that todo, then **stop**. Don't start the next one.
- **The whole task** ("work on t-012"): start at the first todo that is in progress or not started, and **keep going** through the rest in order.

If the id or todo is ambiguous, ask.

Sessions started from the knot TUI (`c` for a todo, `C` for the whole task) open with exactly such a request, already in the task's project directory.

### 1. Claim it — before anything else

```sh
knot claim <id> --json
```

**Exit 3 means another live Claude session is working on this task. Stop there and change nothing**, because two sessions on one task interfere. Tell the user:
- which session holds it: the full session id, which `claude --resume <id>` finds;
- when it claimed the task;
- that you'll take it over only if they say so (`knot claim <id> --force`).

Other points:
- A claim from a session that has ended is stale, and `claim` takes it over automatically.
- If you already hold the claim, it reports `resumed: true`.
- The CLI refuses changes to a task another session holds. If a write exits 3 mid-work, stop and tell the user the same way.

### 2. Read it

Run `knot show <id> --json` and read the body, every todo with its detail, and the recent updates before touching code.

### 3. Mark the task in progress

If its status is anything other than `in-progress`, set it: `knot status <id> in-progress`.

### 4. Do the todos

**One todo**
1. `knot todo show <id> <n> --json` to read its detail.
2. `knot todo start <id> <n>`, unless it's already `in-progress`.
3. Do the work, then close it out (below).

**The whole task.** Loop:
1. `knot next <id> --start --json` returns `{ task, item, started }`.
   - `started: false` means the item was already in progress, left by an earlier session or a person. Say explicitly that you're **resuming** it, not starting fresh, and check what's already done before redoing anything.
2. Read `item.detail`, do the work, then close it out.
3. Repeat until `next` exits 2 (nothing left).

**Closing out a todo**
1. `knot todo done <id> <n>`
2. If you learned something the next person needs (a gotcha, where things live, a decision), add it to the todo's detail:
   ```sh
   knot todo detail <id> <n> --append <<'EOF'
   Found: the retry wrapper masked the race; removed it in e2e/checkout.spec.ts.
   EOF
   ```
3. Add an update for the next reader: what changed (files, commands, results) and what is still unknown. Not a narration of process.
   ```sh
   knot update <id> -m "Wait on the iframe's ready message instead of a 5s timeout. 20/20 green locally; CI still unverified."
   ```

### 5. Finish

When no todo is left pending or in progress (cancelled ones count as closed):
1. `knot status <id> review`. Never set `done` yourself; the user reviews and marks it done.
2. Add a closing update summarising the task as a whole.
3. `knot release <id>`.

If only one todo was asked for and others remain, leave the task `in-progress` and release the claim.

### When you can't finish

Say which of these happened; each has its own exit:

| Situation | Do |
|---|---|
| Blocked: needs a decision or something outside your reach | Leave the todo `[/]`, `knot status <id> blocked`, and add an update saying exactly what's needed and from whom |
| Never really started | `knot todo reset <id> <n>`, or it looks half-done forever |
| Turned out unnecessary | `knot todo cancel <id> <n>`, plus an update giving the reason |

Then `knot release <id>` and tell the user.

**Keep the claim** while you're only pausing for a quick answer you'll continue from. **Release it** whenever you stop working on the task: finished, blocked, or the user moved you on to something else.

## Reference (`knot help`)

```
knot — task manager

  knot list [--status s] [--tag t] [--text q] [--json]
  knot show <id> [--json]
  knot new <title> [--status s] [--tag a,b] [--todo "..." --todo "..."] [--dir d] [--json]
                                        body from stdin; a ## Todo section on
                                        stdin adds todos with their detail
  knot rm <id>
  knot status <id> <status>
  knot title <id> <text>
  knot body <id>                        replace prose from stdin
  knot body <id> --clear                remove it (empty stdin is refused)
  knot tag add|rm|set <id> a,b
  knot dir <id> [path|--clear]          the project dir Claude works in
  knot edit <id>                        open the file in $EDITOR
  knot update <id> -m "text"            (or pipe markdown on stdin)
  knot todo <id>                        list todos
  knot todo add <id> <text>
  knot todo show <id> <n> [--json]      one todo, with its detail
  knot todo detail <id> <n> [--append]  replace (or add to) its detail from stdin
  knot todo detail <id> <n> --clear     remove it (empty stdin is refused)
  knot todo edit <id> <n> <text>
  knot todo rm <id> <n>
  knot todo done <id> <n>
  knot todo start <id> [n]              n omitted = next pending
  knot todo reset <id> <n>              back to not-started
  knot todo cancel <id> <n>             won't be done
  knot next <id> [--start] [--json]     the item to pick up next
  knot claim <id> [--force] [--json]    this session is working on it (exit 3
                                        if another live session already is)
  knot release <id> [--force]           this session is done with it
  knot tags [--json]                    tag counts across the vault
  knot config [path|init|show]          config file (~/.config/knot/config.toml)

statuses: backlog, in-progress (wip), review, done, blocked (block)
```

JSON shapes:
- A **summary** (from `list` and `new`) is `{ id, title, status, tags, todos: { done, total }, updated, error?, claim? }`.
- `claim` is `{ session, pid, host, since, mine }`, present only while a live session holds the task.
- `show --json` adds `body`, `todoItems` (with `ordinal`, `state`, `text`, `detail`), `updates`, `created`, `dir` (when set) and `file`.
- `next --json` is `{ task, item, started }`.
- `claim --json` is `{ claimed: true, resumed, claim }` or `{ claimed: false, holder }`.
