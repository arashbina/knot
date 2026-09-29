import { MARKER_FOR_STATE, STATUS_LIST, progress, shortSession, type ClaimInfo, type Task, type TodoItem } from '@knot-tui/core'

export const HELP = `knot — task manager

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

statuses: ${STATUS_LIST}
`

export function todoRow(item: TodoItem): string {
  return `${item.ordinal}. [${MARKER_FOR_STATE[item.state]}] ${item.text}${item.detail ? '  (+detail)' : ''}`
}

const claimNote = (c: ClaimInfo | undefined) =>
  c ? `  [claimed by ${c.mine ? 'this session' : `session ${shortSession(c.session)}`}]` : ''

export function listRows(tasks: Task[], claims = new Map<string, ClaimInfo | undefined>()): string {
  // Broken-frontmatter ids fall back to the whole filename; don't let one widen every row.
  const idW = Math.max(0, ...tasks.filter((t) => !t.error).map((t) => t.id.length))
  return tasks.map((t) => {
    const p = progress(t)
    const tags = t.tags.length ? `  ${t.tags.map((x) => `#${x}`).join(' ')}` : ''
    const err = t.error ? `  [frontmatter error: ${t.error}]` : ''
    return `${t.id.padEnd(idW)}  ${t.status.padEnd(11)}  ${`${p.done}/${p.total}`.padStart(5)}  ${t.title}${tags}${err}${claimNote(claims.get(t.id))}`
  }).join('\n')
}

const indent = (text: string, by = '    ') => text.split('\n').map((l) => (l ? by + l : l)).join('\n')

export function showTask(task: Task, claim?: ClaimInfo): string {
  const p = progress(task)
  const out = [
    `${task.id}  ${task.title}`,
    `status: ${task.status}   tags: ${task.tags.join(', ') || '-'}   updated: ${task.updated}`,
  ]
  if (task.error) out.push(`frontmatter error: ${task.error}`)
  if (claim) out.push(`claimed by ${claim.mine ? 'this session' : `session ${claim.session}`} (pid ${claim.pid}) since ${claim.since}`)
  if (task.dir) out.push(`dir: ${task.dir}`)
  out.push(`file: ${task.file}`)
  if (task.body) out.push('', task.body)
  out.push('', `Todo ${p.done}/${p.total}`)
  for (const item of task.todos) out.push(`  ${todoRow(item)}`)
  if (task.updates.length) {
    out.push('', 'Updates')
    for (const u of task.updates) out.push(`  ${u.at || 'undated'} — ${u.author}`, indent(u.body), '')
    out.pop()
  }
  return out.join('\n')
}

export function showTodo(item: TodoItem): string {
  return item.detail ? `${todoRow(item)}\n\n${indent(item.detail)}` : todoRow(item)
}
