/**
 * The web viewer end to end: build it, serve it on a temp vault (the welcome task plus
 * three made through the CLI), and check
 * the pages, the API (against the CLI) and live updates. A Next build is slow, so
 * this is `npm run smoke`, not part of `npm test`.
 *
 * `next start`, not `next dev`: Next allows one dev server per project, and one may
 * already be running (`npm run web`). A build doesn't touch a dev server's `.next/dev`.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULT_KEYS } from '../packages/tui/src/keys.js'
import { ensureWelcome } from '../packages/tui/src/welcome.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NEXT = path.join(ROOT, 'node_modules/.bin/next')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knot-smoke-'))
const env = {
  ...process.env,
  KNOT_DIR: dir,
  KNOT_CONFIG: path.join(dir, 'none.toml'),
  // Often run from inside a Claude session; don't let its identity leak into the CLI.
  CLAUDE_CODE_SESSION_ID: '',
  CLAUDE_PID: '',
}
let server: ChildProcess | undefined
let base = ''
/** The id of the task whose markdown the render check looks at. */
let rendered = ''

function knot(...args: string[]) {
  return knotIn('', ...args)
}

function knotIn(input: string, ...args: string[]) {
  const r = spawnSync(path.join(ROOT, 'bin/knot'), args, { encoding: 'utf8', env, input })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo
      s.close(() => resolve(port))
    })
  })
}

before(async () => {
  ensureWelcome(dir, DEFAULT_KEYS)
  knot('new', 'Draft the quarterly plan', '--tag', 'planning', '--todo', 'Collect the numbers')
  knot('new', 'Fix the login redirect', '--status', 'done')
  rendered = knotIn('Intro.\n\n```\ncode\n```\n\n> a quote\n\n## Todo\n\n- [ ] one\n    its detail\n', 'new', 'Render check').trim()
  const build = spawnSync(NEXT, ['build', 'packages/web', '--webpack'], { cwd: ROOT, env, encoding: 'utf8' })
  assert.equal(build.status, 0, `next build failed:\n${build.stdout}\n${build.stderr}`)
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  server = spawn(NEXT, ['start', 'packages/web', '-p', String(port), '-H', '127.0.0.1'], { cwd: ROOT, env, stdio: 'ignore' })
  const end = Date.now() + 30_000
  for (;;) {
    try {
      if ((await fetch(`${base}/api/tasks`)).ok) break
    } catch { /* not listening yet */ }
    assert.ok(Date.now() < end, 'next start never answered')
    await new Promise((r) => setTimeout(r, 250))
  }
}, { timeout: 180_000 })

after(() => {
  server?.kill()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('/api/tasks and /api/tasks/<id> are `knot list --json` and `knot show --json`', async () => {
  const list = JSON.parse(knot('list', '--json'))
  assert.equal(list.length, 4)
  assert.deepEqual(await (await fetch(`${base}/api/tasks`)).json(), list)
  assert.deepEqual(await (await fetch(`${base}/api/tasks/t-001`)).json(), JSON.parse(knot('show', 't-001', '--json')))
  assert.equal((await fetch(`${base}/api/tasks/t-999`)).status, 404)
  assert.equal((await fetch(`${base}/api/tasks`, { method: 'POST' })).status, 405)
})

test('/ lists every task in `knot list` order', async () => {
  const html = await (await fetch(`${base}/?done=1`)).text()
  const rows = [...html.matchAll(/class="row" href="\/tasks\/([^"?]+)/g)].map((m) => decodeURIComponent(m[1]))
  assert.deepEqual(rows, JSON.parse(knot('list', '--json')).map((t: { id: string }) => t.id))
})

test('a task page renders its markdown and todos, with nothing to click that writes', async () => {
  const html = await (await fetch(`${base}/tasks/${rendered}`)).text()
  assert.match(html, new RegExp(`<title>${rendered} · knot</title>`))
  assert.match(html, /<pre>/)
  assert.match(html, /<blockquote>/)
  assert.match(html, /class="todos"/)
  assert.doesNotMatch(html, /<form|<button/)
})

test('/api/events says `tasks` when the CLI changes a task', async () => {
  const abort = new AbortController()
  const res = await fetch(`${base}/api/events`, { signal: abort.signal })
  assert.equal(res.headers.get('content-type'), 'text/event-stream')
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const seen = () => text.includes('data: tasks')
  // The watcher starts with the first subscriber and takes a moment to be ready,
  // so write once it likely is, and once more in case it wasn't.
  const writes = [500, 2500].map((ms) => setTimeout(() => seen() || knot('todo', 'add', 't-001', 'smoke'), ms))
  const timeout = setTimeout(() => abort.abort(), 6000)
  try {
    while (!seen()) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch { /* aborted by the timeout */ }
  finally {
    writes.forEach(clearTimeout)
    clearTimeout(timeout)
    abort.abort()
  }
  assert.ok(seen(), `no tasks event; got ${JSON.stringify(text)}`)
})
