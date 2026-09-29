import Link from 'next/link'
import { Suspense } from 'react'
import { NotFoundError, findTask, listView, tildify } from '@knot-tui/core'
import { readParams, toQuery, type Search } from '../lib/params.js'
import { snapshot, type Snapshot } from '../lib/vault.js'
import { SearchBox } from './SearchBox.js'
import { TaskDetail } from './TaskDetail.js'
import { TaskList } from './TaskList.js'

interface ViewerProps {
  search: Search
  /** The task id in the URL, if one is open. */
  open?: string
}

/** The TUI's layout in a browser: the task list, and the open task beside it. */
export function Viewer({ search, open }: ViewerProps) {
  let snap: Snapshot
  try { snap = snapshot() }
  catch (e) {
    if (!(e instanceof NotFoundError)) throw e
    return <p className="banner">{e.message}</p>
  }
  const params = readParams(search)
  const hideDone = params.done === undefined ? snap.config.config.ui.hideDone : !params.done
  const { shown, hits, hidden, errors } = listView(snap.tasks, { hideDone, query: params.q })
  const task = open ? findTask(snap.tasks, open) : undefined
  const here = open ? `/tasks/${encodeURIComponent(open)}` : '/'
  const empty = params.q && shown.length ? `no match for /${params.q}`
    : hidden && !shown.length ? `all ${hidden} done hidden`
    : 'no tasks yet'

  return (
    <div className="app">
      <header className="top">
        <Link href={`/${toQuery(params)}`} className="brand">knot</Link>
        <span className="vault">{tildify(snap.vault)}</span>
        <span className="counts">
          {`${params.q ? `${hits.length}/` : ''}${shown.length} ${shown.length === 1 ? 'task' : 'tasks'}`}
          {hidden > 0 && ` · ${hidden} done hidden`}
          {errors > 0 && <span className="error"> · {errors} unparseable</span>}
        </span>
      </header>
      {snap.config.error && <p className="banner">config {tildify(snap.config.path)}: {snap.config.error}</p>}
      <div className={open ? 'panes has-task' : 'panes'}>
        <nav className="list" aria-label="Tasks">
          <div className="tools">
            <Suspense><SearchBox /></Suspense>
            <Link className="toggle" href={`${here}${toQuery({ ...params, done: hideDone })}`} scroll={false}>
              {hideDone ? 'show done' : 'hide done'}
            </Link>
          </div>
          <TaskList hits={hits} claims={snap.claims} current={task?.file} params={params} empty={empty} />
        </nav>
        <main className="detail">
          {task
            ? <TaskDetail task={task} claim={snap.claims.get(task.id)} back={`/${toQuery(params)}`} />
            : <p className="hint">{open ? `no task ${open}` : 'select a task · / searches'}</p>}
        </main>
      </div>
    </div>
  )
}
