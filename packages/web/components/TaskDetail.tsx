import Link from 'next/link'
import { STATUS_STYLE, formatDate, formatStamp, progress, shortSession, tildify, type ClaimInfo, type Task, type TodoItem } from '@knot-tui/core'
import { Glyph, todoStyle } from './Glyph.js'
import { Markdown } from './Markdown.js'

/** One task, as the TUI's detail and todo panes show it. Nothing on it changes anything. */
export function TaskDetail({ task, claim, back }: { task: Task; claim?: ClaimInfo; back: string }) {
  const p = progress(task)
  return (
    <article className="task">
      <Link href={back} className="back">← tasks</Link>
      <h1 className="task-title">
        {task.error && <span className="error">⚠ </span>}
        {task.title}
      </h1>
      <p className="task-meta">
        <span>{task.id}</span>
        <span style={{ color: `var(--status-${task.status})` }}>{STATUS_STYLE[task.status].label}</span>
        {task.updated && <time dateTime={task.updated}>{formatDate(task.updated)}</time>}
        {task.tags.map((tag) => <span key={tag} className="tag-accent">#{tag}</span>)}
        {task.dir && <span className="dir" title={task.dir}>{tildify(task.dir)}</span>}
      </p>
      {claim && <p className="claim">◆ claude · session {shortSession(claim.session)} · since {formatDate(claim.since)}</p>}
      {task.error && <p className="error">⚠ frontmatter: {task.error}</p>}

      {task.body ? <Markdown>{task.body}</Markdown> : <p className="faint">no description</p>}

      <section>
        <h2 className="section">Todo <span className="count">{p.done}/{p.total}</span></h2>
        {task.todos.length
          ? <ol className="todos">{task.todos.map((item) => <Todo key={item.line} item={item} />)}</ol>
          : <p className="faint">no todos</p>}
      </section>

      {task.updates.length > 0 && (
        <section>
          <h2 className="section">Updates</h2>
          <ol className="updates">
            {task.updates.map((u, i) => (
              <li key={i}>
                <p className="update-head">
                  <span>{formatStamp(u.at)}</span>
                  <span style={{ color: `var(--author-${u.author})` }}>{u.author}</span>
                </p>
                <Markdown>{u.body}</Markdown>
              </li>
            ))}
          </ol>
        </section>
      )}
    </article>
  )
}

function Todo({ item }: { item: TodoItem }) {
  const head = (
    <>
      <span className="ordinal">{item.ordinal}</span>
      <Glyph state={item.state} />
      <span className="todo-text" style={todoStyle(item.state)}><Markdown inline>{item.text}</Markdown></span>
    </>
  )
  if (!item.detail) return <li className="todo"><div className="todo-head">{head}</div></li>
  return (
    <li className="todo">
      <details>
        <summary className="todo-head">{head}<span className="more" aria-hidden="true" /></summary>
        <div className="todo-detail"><Markdown>{item.detail}</Markdown></div>
      </details>
    </li>
  )
}
