/**
 * Prints static TUI frames without a TTY: `npm run preview -- [COLSxROWS] [--plain]`.
 * Honours KNOT_DIR; otherwise a throwaway temp vault holding the first-launch welcome task (never tasks/).
 */
import { createTask, openStore } from '@knot-tui/core'
import { DEFAULT_KEYS } from '../packages/tui/src/keys.js'
import { ensureWelcome } from '../packages/tui/src/welcome.js'
import { startHarness, tempDir } from './harness.js'

const args = process.argv.slice(2)
const size = args.find((a) => /^\d+x\d+$/.test(a)) ?? '120x36'
const [cols, rows] = size.split('x').map(Number)
const plain = args.includes('--plain') || !process.stdout.isTTY

let dir = process.env.KNOT_DIR
if (!dir) {
  dir = tempDir('knot-preview-')
  ensureWelcome(dir, DEFAULT_KEYS)
  // A few tasks of the user's own, so the list shows more than one row, status and search narrowing.
  const store = openStore(dir)
  createTask(store, { title: 'Draft the quarterly plan', tags: ['planning'], todos: ['Collect the numbers', 'Write the summary'] })
  createTask(store, { title: 'Fix the login redirect that drops the return URL after SSO', status: 'blocked', tags: ['bug'] })
  createTask(store, { title: 'Tidy the release checklist', status: 'done' })
}

const SCENES: [string, string[]][] = [
  ['start', []],
  ['todo opened', ['enter']],
  ['detail focused, scrolled', ['l', 'j', 'j', 'j']],
  ['todo pane focused, second todo', ['l', 'l', 'j']],
  ['search /#welcome', ['/', ...'#welcome', 'enter']],
  ['rename inline', ['i']],
]

for (const [name, keys] of SCENES) {
  const h = await startHarness({ dir, cols, rows })
  await h.press(...keys)
  const frame = plain ? h.text() : h.frame()
  process.stdout.write(`\n── ${name} (${cols}×${rows}) ${keys.length ? `keys: ${keys.join(' ')} ` : ''}──\n${frame}\n`)
  h.unmount()
}
process.stdout.write(`\nvault: ${dir}\n`)
