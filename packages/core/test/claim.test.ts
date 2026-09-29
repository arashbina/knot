import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { claimTask, currentSession, dropClaim, listClaims, liveClaim, openStore, processStart, releaseTask, sessionId, shortSession, type Session } from '../src/index.js'

const store = () => openStore(fs.mkdtempSync(path.join(os.tmpdir(), 'knot-claim-')))

/** A fake process table: pid → start time. Missing = not running. */
const table = (procs: Record<number, string>) => (pid: number) => procs[pid]

const session = (name: string, pid: number, started = 'T0', host = os.hostname()): Session =>
  ({ session: name, pid, started, host })

const A = session('session-a', 100)
const B = session('session-b', 200)

test('currentSession is the Claude session, tied to the Claude process', () => {
  const s = currentSession({ CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_PID: '100' }, 55, table({ 100: 'T0' }))
  assert.deepEqual(s, { session: 'abc', pid: 100, started: 'T0', host: os.hostname() })
})

test('outside Claude, the session is the calling shell', () => {
  const s = currentSession({}, 55, table({ 55: 'T9' }))
  assert.deepEqual(s, { session: 'pid-55', pid: 55, started: 'T9', host: os.hostname() })
})

test('outside Claude, the calling shell is KNOT_CALLER_PID when set — bin/knot runs behind a tsx wrapper process', () => {
  const probe = table({ 77: 'T7', 100: 'T0' })
  assert.deepEqual(currentSession({ KNOT_CALLER_PID: '77' }, undefined, probe), { session: 'pid-77', pid: 77, started: 'T7', host: os.hostname() })
  assert.equal(sessionId({ KNOT_CALLER_PID: '77' }), 'pid-77')
  assert.equal(currentSession({ KNOT_CALLER_PID: '77', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_PID: '100' }, undefined, probe).session, 'abc', 'Claude still wins')
  for (const junk of ['', '0', '-3', '1.5', 'abc']) {
    assert.equal(currentSession({ KNOT_CALLER_PID: junk }, undefined, probe).pid, process.ppid, `ignores ${JSON.stringify(junk)}`)
  }
})

test('a free task can be claimed, and re-claimed by the same session', () => {
  const s = store()
  const probe = table({ 100: 'T0' })
  const first = claimTask(s, 't-001', { session: A, probe })
  assert.equal(first.ok, true)
  assert.equal(first.ok && first.resumed, false)
  const again = claimTask(s, 't-001', { session: A, probe })
  assert.equal(again.ok && again.resumed, true)
  assert.equal(liveClaim(s, 't-001', probe)?.session, 'session-a')
})

test('a task held by another live session is refused, naming the holder', () => {
  const s = store()
  const probe = table({ 100: 'T0', 200: 'T0' })
  claimTask(s, 't-001', { session: A, probe })
  const r = claimTask(s, 't-001', { session: B, probe })
  assert.equal(r.ok, false)
  assert.equal(!r.ok && r.holder.session, 'session-a')
})

test('a claim whose process is gone — or whose pid was reused — is stale and can be taken', () => {
  const s = store()
  claimTask(s, 't-001', { session: A, probe: table({ 100: 'T0' }) })
  assert.equal(liveClaim(s, 't-001', table({ 200: 'T0' })), undefined, 'process gone')
  assert.equal(liveClaim(s, 't-001', table({ 100: 'LATER', 200: 'T0' })), undefined, 'pid reused')
  assert.equal(claimTask(s, 't-001', { session: B, probe: table({ 200: 'T0' }) }).ok, true)
})

test("a claim from another machine can't be checked, so it counts as live", () => {
  const s = store()
  claimTask(s, 't-001', { session: session('remote', 100, 'T0', 'other-host'), probe: table({}) })
  assert.equal(liveClaim(s, 't-001', table({}))?.session, 'remote')
})

test('force takes over a live claim', () => {
  const s = store()
  const probe = table({ 100: 'T0', 200: 'T0' })
  claimTask(s, 't-001', { session: A, probe })
  assert.equal(claimTask(s, 't-001', { session: B, probe, force: true }).ok, true)
  assert.equal(liveClaim(s, 't-001', probe)?.session, 'session-b')
})

test('only the holder releases, unless forced', () => {
  const s = store()
  const probe = table({ 100: 'T0', 200: 'T0' })
  claimTask(s, 't-001', { session: A, probe })
  assert.equal(releaseTask(s, 't-001', { session: B, probe }), false)
  assert.equal(liveClaim(s, 't-001', probe)?.session, 'session-a')
  assert.equal(releaseTask(s, 't-001', { session: A, probe }), true)
  assert.equal(liveClaim(s, 't-001', probe), undefined)
  claimTask(s, 't-001', { session: A, probe })
  assert.equal(releaseTask(s, 't-001', { session: B, probe, force: true }), true)
})

test('processStart: a running process has a start time; a killed, unreaped (zombie) one does not', async () => {
  const { spawn } = await import('node:child_process')
  const child = spawn('sleep', ['30'], { stdio: 'ignore' })
  const pid = child.pid!
  assert.ok(processStart(pid), 'running')
  child.kill()
  const deadline = Date.now() + 2000
  // Busy-wait without yielding: node can't reap the child, so it stays a zombie.
  while (processStart(pid) !== undefined && Date.now() < deadline) { /* spin */ }
  assert.equal(processStart(pid), undefined, 'a zombie is not a live session')
})

test('listClaims returns only live claims', () => {
  const s = store()
  claimTask(s, 't-001', { session: A, probe: table({ 100: 'T0' }) })
  claimTask(s, 't-002', { session: B, probe: table({ 200: 'T0' }) })
  const live = listClaims(s, table({ 100: 'T0' }))
  assert.deepEqual(live.map((c) => [c.task, c.session]), [['t-001', 'session-a']])
  assert.deepEqual(listClaims(store(), table({})), [], 'no claims folder yet')
})

test('claims live in a hidden folder that never shows up as a task', () => {
  const s = store()
  claimTask(s, 't-001', { session: A, probe: table({ 100: 'T0' }) })
  assert.ok(fs.existsSync(path.join(s.dir, '.knot', 'claims', 't-001.json')))
})

test('an id is frontmatter text: one like ../../x still claims, lists and releases inside the claims folder', () => {
  const s = store()
  const probe = table({ 100: 'T0' })
  for (const id of ['../../x', 'a/b', '100%']) {
    assert.equal(claimTask(s, id, { session: A, probe }).ok, true, id)
    assert.equal(liveClaim(s, id, probe)?.task, id)
  }
  assert.deepEqual(fs.readdirSync(s.dir), ['.knot'])
  assert.deepEqual(fs.readdirSync(path.join(s.dir, '.knot')), ['claims'])
  assert.deepEqual(listClaims(s, probe).map((c) => c.task).sort(), ['../../x', '100%', 'a/b'])
  assert.equal(releaseTask(s, '../../x', { session: A, probe }), true)
  dropClaim(s, 'a/b')
  dropClaim(s, '100%')
  assert.deepEqual(listClaims(s, probe), [])
})

test('a long non-ASCII id still names a claim file: only what could leave the folder is escaped', () => {
  const s = store()
  const probe = table({ 100: 'T0' })
  const id = 'Отчёт о переговорах с поставщиками по новому контракту'
  assert.equal(claimTask(s, id, { session: A, probe }).ok, true)
  assert.equal(liveClaim(s, id, probe)?.task, id)
  dropClaim(s, id)
  assert.equal(liveClaim(s, id, probe), undefined)
})

test('stray files in the claims folder never break listing', () => {
  const s = store()
  const probe = table({ 100: 'T0' })
  claimTask(s, 't-001', { session: A, probe })
  const dir = path.join(s.dir, '.knot', 'claims')
  fs.writeFileSync(path.join(dir, 'x%.json'), '{')
  fs.writeFileSync(path.join(dir, 'junk.json'), 'not json')
  assert.deepEqual(listClaims(s, probe).map((c) => c.task), ['t-001'])
})

test('shortSession keeps a pid-<n> whole and cuts a Claude session id to 8 characters', () => {
  assert.equal(shortSession('pid-1234567'), 'pid-1234567')
  assert.equal(shortSession('0f3c9a2e-1111-2222-3333-444444444444'), '0f3c9a2e')
})
