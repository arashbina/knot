import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  NotFoundError, claimTask, createTask, load, loadAll, openStore, processStart, setStatus, setTodoState, sortTasks,
  type Store, type Task,
} from '@knot-tui/core'

// `server-only` resolves only inside Next's bundler; here it's an empty module.
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === 'server-only' ? { url: 'data:text/javascript,', shortCircuit: true } : next(specifier, context),
})
const { listJson, showJson, snapshot } = await import('../lib/vault.js')
const { subscribe } = await import('../lib/events.js')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const KNOT = path.join(ROOT, 'bin/knot')

/** A stand-in Claude session: a live process a claim can be tied to. */
function session(t: { after(fn: () => void): void }, name: string) {
  const proc = spawn('sleep', ['60'], { stdio: 'ignore' })
  t.after(() => proc.kill())
  const pid = proc.pid!
  return { session: { session: name, pid, started: processStart(pid) ?? '', host: os.hostname() }, end: () => proc.kill() }
}

/** A vault the web layer reads through $KNOT_DIR, as `npm run web` would. */
function vault(t: { after(fn: () => void): void }): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-web-'))
  const saved = { dir: process.env.KNOT_DIR, config: process.env.KNOT_CONFIG }
  process.env.KNOT_DIR = dir
  process.env.KNOT_CONFIG = path.join(dir, 'none.toml')
  t.after(() => {
    process.env.KNOT_DIR = saved.dir
    process.env.KNOT_CONFIG = saved.config
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const store = openStore(dir)
  const a = createTask(store, { title: 'Parser: rework', tags: ['core'], body: 'Body with `code`.', todos: ['one', { text: 'two', detail: 'More.' }] })
  setTodoState(a, 1, 'done')
  createTask(store, { title: 'Shipped', status: 'done' })
  createTask(store, { title: 'Blocked on review', status: 'blocked', dir })
  fs.writeFileSync(path.join(dir, 't-004-broken.md'), '---\ntitle: [unclosed\n---\n\nBody.\n')
  return store
}

function knot(args: string[]) {
  const r = spawnSync(KNOT, [...args, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_PID: '' },
  })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

async function until(what: string, ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('the API serves exactly what `knot list --json` and `knot show --json` print', (t) => {
  const store = vault(t)
  claimTask(store, 't-003', { session: session(t, 'agent-a').session })
  const list = knot(['list'])
  assert.equal(list.length, 4)
  assert.deepEqual(listJson(), list)
  for (const { id } of list) assert.deepEqual(showJson(id), knot(['show', id]), id)
  assert.equal(listJson().find((s) => s.id === 't-003')?.claim?.mine, false, 'the viewer is never the claim holder')
  assert.equal(showJson('t-999'), undefined)
})

test('snapshot: every task in the TUI order, and live claims only', (t) => {
  const store = vault(t)
  const live = session(t, 'live')
  const dead = session(t, 'dead')
  claimTask(store, 't-001', { session: live.session })
  claimTask(store, 't-003', { session: dead.session })
  dead.end()
  spawnSync('sleep', ['0.1'])

  const snap = snapshot()
  assert.equal(snap.vault, store.dir)
  assert.deepEqual(snap.tasks.map((x: Task) => x.file), sortTasks(loadAll(store)).map((x) => x.file))
  assert.deepEqual([...snap.claims.keys()], ['t-001'])
  assert.ok(snap.tasks.some((x: Task) => x.error), 'a broken file still loads, flagged')
})

test('a missing vault is a NotFoundError, which the routes answer with 503', (t) => {
  vault(t)
  process.env.KNOT_DIR = path.join(os.tmpdir(), 'knot-web-no-such-vault')
  assert.throws(() => listJson(), NotFoundError)
  assert.throws(() => snapshot(), NotFoundError)
  assert.throws(() => subscribe(() => {}), NotFoundError)
})

test('subscribe: a task write says `tasks`; a session dying says `claims`', async (t) => {
  const store = vault(t)
  const agent = session(t, 'agent')
  claimTask(store, 't-001', { session: agent.session })
  const seen: string[] = []
  const unsubscribe = subscribe((change) => seen.push(change))
  t.after(unsubscribe)

  // chokidar needs a moment before it reports anything, so write until it does,
  // slower than the 80ms debounce (each write restarts it).
  for (let i = 0; !seen.includes('tasks'); i++) {
    assert.ok(i < 20, 'timed out waiting for a tasks event')
    setStatus(load(store, 't-002')!, i % 2 ? 'done' : 'review')
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(!seen.includes('claims'))

  agent.end()
  await until('a claims event after the session ends', () => seen.includes('claims'), 5000)
})
