import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTask } from '@knot-tui/core'
import { herdrAgentArgs, herdrName, herdrSplitArgs, inHerdr, launchInHerdr, paneIdFrom, planLaunch, takeoverCommand } from '../src/launch.js'
import { DEFAULT_KEYS } from '../src/keys.js'

const task = parseTask('/v/t-012.md', "---\nid: t-012\ntitle: 'Flaky e2e test: checkout'\n---\n\n## Todo\n\n- [x] one\n- [ ] Wait on the iframe's ready message\n")
const env = { KNOT_DIR: '/vault' }

test('one todo: the prompt names the todo and says to stop after it', () => {
  const plan = planLaunch(task, task.todos[1], '/code/app', env)
  assert.equal(plan.name, 't-012', 'one session per task, so the next todo can reuse it')
  assert.equal(plan.label, 't-012 #2')
  assert.equal(plan.clearContext, false)
  assert.match(plan.prompt, /knot skill/)
  assert.match(plan.prompt, /todo 2 of t-012/)
  assert.match(plan.prompt, /Wait on the iframe's ready message/)
  assert.match(plan.prompt, /[Ss]top after/)
  assert.deepEqual([plan.task, plan.ordinal, plan.dir, plan.env], ['t-012', 2, '/code/app', env])
})

test('whole task: the prompt names the task and says to keep going', () => {
  const plan = planLaunch(task, undefined, '/code/app', env)
  assert.equal(plan.name, 't-012')
  assert.equal(plan.label, 't-012')
  assert.equal(plan.ordinal, undefined)
  assert.match(plan.prompt, /work on t-012/)
  assert.match(plan.prompt, /continue/)
})

test('inside herdr: split beside the TUI in the project dir with the vault env, then start claude in that pane', () => {
  const plan = planLaunch(task, task.todos[1], '/code/app', env)
  assert.deepEqual(herdrSplitArgs(plan, 'w4:p1'), ['pane', 'split', '--pane', 'w4:p1', '--direction', 'right', '--cwd', '/code/app', '--env', 'KNOT_DIR=/vault', '--focus'])
  assert.deepEqual(herdrAgentArgs(plan, 'w4:p5'), ['agent', 'start', 't-012', '--kind', 'claude', '--pane', 'w4:p5', '--', '--name', 't-012'], 'no request at startup — it goes in with agent prompt once Claude is ready')
  assert.equal(paneIdFrom('{"result":{"pane":{"pane_id":"w4:p5"},"type":"pane_info"}}'), 'w4:p5')
  assert.equal(paneIdFrom('not json'), undefined)
})

test('herdr is detected from its environment', () => {
  assert.equal(inHerdr({ HERDR_ENV: '1', HERDR_PANE_ID: 'w4:p1' }), true)
  assert.equal(inHerdr({}), false)
})

test('outside herdr: claude runs in the project dir with the vault env', () => {
  const plan = planLaunch(task, undefined, '/code/app', env)
  assert.deepEqual(takeoverCommand(plan), { command: 'claude', args: ['--name', 't-012', plan.prompt], cwd: '/code/app', env })
})

test('c works on the selected todo, C on the whole task', () => {
  assert.equal(DEFAULT_KEYS.c, 'claude-todo')
  assert.equal(DEFAULT_KEYS.C, 'claude-task')
})

test("herdr agent names follow herdr's rule: lowercase letter first, [a-z0-9_-], at most 32", () => {
  const valid = /^[a-z][a-z0-9_-]{0,31}$/
  const named = (id: string, ordinal?: number) => herdrName({ ...planLaunch(task, undefined, '/d', env), task: id, ordinal })
  assert.equal(named('t-026', 1), 't-026', 'named after the task, whatever todo started it')
  assert.equal(named('t-026'), 't-026')
  for (const name of [named('T-026', 3), named('t-004-rate-limiter-draft-with-a-long-name', 12), named('026 weird id!'), named('')]) {
    assert.match(name, valid, name)
  }
})

/** A fake herdr: records every call; `start` and `wait` behave as each test says, `pane get` reports `agentInPane`. */
/** Shells in a just-split pane take a moment to reach their prompt; until then herdr says `agent_pane_busy`. */
const paneBusy = () => Object.assign(new Error('agent target pane w4:p9 is not an available shell'), { code: 'agent_pane_busy' })
const noSleep = async () => undefined

function fakeHerdr(opts: { start?: 'ok' | 'fail'; agentInPane?: boolean; wait?: 'ok' | 'fail'; open?: string; busyStarts?: number }) {
  const calls: string[][] = []
  let starts = 0
  const run = async (_bin: string, args: string[]) => {
    calls.push(args)
    const cmd = `${args[0]} ${args[1]}`
    if (cmd === 'agent start' && starts++ < (opts.busyStarts ?? 0)) throw paneBusy()
    if (cmd === 'agent get') {
      if (!opts.open) throw new Error('agent target not found')
      return JSON.stringify({ result: { agent: { pane_id: 'w4:p7', agent_status: opts.open } } })
    }
    if (cmd === 'pane split') return '{"result":{"pane":{"pane_id":"w4:p9"}}}'
    if (cmd === 'agent start' && opts.start === 'fail') throw new Error('timed out waiting for agent startup')
    if (cmd === 'pane get') return JSON.stringify({ result: { pane: { pane_id: 'w4:p9', ...(opts.agentInPane ? { agent: 'claude' } : {}) } } })
    if (cmd === 'agent wait' && opts.wait === 'fail') throw new Error('timeout')
    return '{"result":{"type":"ok"}}'
  }
  return { calls, run, cmds: () => calls.map((a) => `${a[0]} ${a[1]}`) }
}

const HERDR = { HERDR_ENV: '1', HERDR_PANE_ID: 'w4:p1' }

test('herdr: split, start Claude, then send the request to that pane once it is ready', async () => {
  const plan = planLaunch(task, task.todos[1], '/code/app', env)
  const h = fakeHerdr({ start: 'ok' })
  assert.match(await launchInHerdr(plan, { env: HERDR, run: h.run, sleep: noSleep }), /w4:p9/)
  assert.deepEqual(h.cmds(), ['agent get', 'pane split', 'agent start', 'agent prompt'])
  assert.deepEqual(h.calls[3], ['agent', 'prompt', 'w4:p9', plan.prompt])
})

test('herdr: a start that "fails" with Claude running in the pane is not killed — wait for it, then send the request', async () => {
  const plan = planLaunch(task, task.todos[1], '/code/app', env)
  const h = fakeHerdr({ start: 'fail', agentInPane: true })
  const notes: string[] = []
  await launchInHerdr(plan, { env: HERDR, run: h.run, notify: (m) => notes.push(m), sleep: noSleep })
  assert.deepEqual(h.cmds(), ['agent get', 'pane split', 'agent start', 'pane get', 'agent wait', 'agent prompt'])
  assert.deepEqual(h.calls[4].slice(0, 5), ['agent', 'wait', 'w4:p9', '--until', 'idle'])
  assert.ok(!h.cmds().includes('pane close'), 'never close a pane with Claude in it')
  assert.match(notes.join(' '), /w4:p9/, 'the user is told where Claude is waiting')
})

test('herdr: if Claude never becomes ready, the request is not sent and the pane stays', async () => {
  const plan = planLaunch(task, undefined, '/code/app', env)
  const h = fakeHerdr({ start: 'fail', agentInPane: true, wait: 'fail' })
  await assert.rejects(launchInHerdr(plan, { env: HERDR, run: h.run, sleep: noSleep }), /w4:p9/)
  assert.ok(!h.cmds().includes('agent prompt'))
  assert.ok(!h.cmds().includes('pane close'))
})

test('herdr: if no agent ever appeared, the empty pane is closed and the error surfaces', async () => {
  const plan = planLaunch(task, undefined, '/code/app', env)
  const h = fakeHerdr({ start: 'fail', agentInPane: false })
  await assert.rejects(launchInHerdr(plan, { env: HERDR, run: h.run, sleep: noSleep }), /timed out/)
  assert.deepEqual(h.cmds(), ['agent get', 'pane split', 'agent start', 'pane get', 'pane close'])
})

test("herdr: the task's session is still open and idle — the next todo goes to it, no new pane", async () => {
  const plan = planLaunch(task, task.todos[1], '/code/app', env)
  const h = fakeHerdr({ open: 'idle' })
  assert.match(await launchInHerdr(plan, { env: HERDR, run: h.run, sleep: noSleep }), /w4:p7/)
  assert.deepEqual(h.cmds(), ['agent get', 'agent prompt', 'agent focus'])
  assert.deepEqual(h.calls[0], ['agent', 'get', 't-012'])
  assert.deepEqual(h.calls[1], ['agent', 'prompt', 'w4:p7', plan.prompt])
})

test('herdr: with clear-between-todos, the reused session gets /clear before the next request', async () => {
  const plan = planLaunch(task, task.todos[1], '/code/app', env, { clearContext: true })
  const h = fakeHerdr({ open: 'done' })
  await launchInHerdr(plan, { env: HERDR, run: h.run, sleep: noSleep })
  assert.deepEqual(h.cmds(), ['agent get', 'agent prompt', 'agent wait', 'agent prompt', 'agent focus'])
  assert.deepEqual(h.calls[1], ['agent', 'prompt', 'w4:p7', '/clear'])
  assert.deepEqual(h.calls[3], ['agent', 'prompt', 'w4:p7', plan.prompt])
})

test("herdr: the task's session is busy — say where it is, send nothing, open nothing", async () => {
  for (const status of ['working', 'blocked', 'unknown']) {
    const plan = planLaunch(task, task.todos[1], '/code/app', env)
    const h = fakeHerdr({ open: status })
    await assert.rejects(launchInHerdr(plan, { env: HERDR, run: h.run, sleep: noSleep }), /busy.*w4:p7/)
    assert.deepEqual(h.cmds(), ['agent get'], status)
  }
})

test("herdr: a just-split pane whose shell isn't at its prompt yet is retried, not given up on", async () => {
  const plan = planLaunch(task, task.todos[1], '/code/app', env)
  const h = fakeHerdr({ busyStarts: 3 })
  let slept = 0
  await launchInHerdr(plan, { env: HERDR, run: h.run, sleep: async () => { slept++ } })
  assert.deepEqual(h.cmds(), ['agent get', 'pane split', 'agent start', 'agent start', 'agent start', 'agent start', 'agent prompt'])
  assert.equal(slept, 3)
  assert.ok(!h.cmds().includes('pane close'))
})

test('herdr: a pane whose shell never gets there is closed, with a message that says so', async () => {
  const plan = planLaunch(task, task.todos[1], '/code/app', env)
  const h = fakeHerdr({ busyStarts: Infinity })
  await assert.rejects(launchInHerdr(plan, { env: HERDR, run: h.run, sleep: noSleep }), /shell.*w4:p9|w4:p9.*shell/)
  assert.ok(h.cmds().filter((c) => c === 'agent start').length > 5, 'retried')
  assert.equal(h.cmds().at(-1), 'pane close')
})
