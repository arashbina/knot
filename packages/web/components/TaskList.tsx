import Link from 'next/link'
import { STATUS_STYLE, progress, type ClaimInfo, type SearchHit } from '@knot-tui/core'
import { taskHref, type ViewParams } from '../lib/params.js'
import { Highlight } from './Highlight.js'

interface TaskListProps {
  hits: SearchHit[]
  claims: Map<string, ClaimInfo>
  /** The open task's file, to mark its row. */
  current?: string
  params: ViewParams
  /** Shown in place of rows when `hits` is empty. */
  empty: string
}

/** The TUI's task list: title, then status, `◆ claude`, progress and tags. */
export function TaskList({ hits, claims, current, params, empty }: TaskListProps) {
  if (!hits.length) return <p className="empty">{empty}</p>
  return (
    <ul className="rows">
      {hits.map((hit) => {
        const { task } = hit
        const p = progress(task)
        return (
          <li key={task.file}>
            <Link className="row" href={taskHref(task.id, params)} aria-current={task.file === current ? 'page' : undefined}>
              <span className="row-title">
                {task.error && <span className="error">⚠ </span>}
                <Highlight text={task.title} positions={hit.title} />
              </span>
              <span className="row-meta">
                <span style={{ color: `var(--status-${task.status})` }}>{STATUS_STYLE[task.status].label}</span>
                {claims.has(task.id) && <span className="claude">◆ claude</span>}
                {p.total > 0 && <span>{p.done}/{p.total}</span>}
                {task.tags.map((tag) => (
                  <span key={tag} className="tag">#<Highlight text={tag} positions={hit.tags[tag] ?? []} /></span>
                ))}
                {task.error && <span className="error">frontmatter error</span>}
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
