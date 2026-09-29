import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The web viewer must stay read-only: no core mutator, no server action, no route
// that answers anything but GET, and no reaching around core to the filesystem.

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Tests aren't served, and may build fixture vaults. */
const SKIP = new Set(['node_modules', '.next', 'test'])

/** Core exports that write: to a task file, a claim, the config, or through $EDITOR. */
const MUTATOR = /^(set|add|remove|create|delete)[A-Z]|^(claimTask|releaseTask|dropClaim|spawnEditor|initConfig)$/
const CORE = /^@knot-tui\/core(\/|$)|\/core\/src\//
const WRITERS = /^(node:)?(fs|fs\/promises|child_process)$/
const NON_GET = ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

function violations(file: string, src: string): string[] {
  const found: string[] = []
  for (const [, clause, from] of src.matchAll(/\b(?:import|export)\s+([^'";]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (WRITERS.test(from)) found.push(`imports ${from}`)
    if (!CORE.test(from) || /^type\s/.test(clause)) continue
    const named = /^\{([^}]*)\}$/.exec(clause.trim())
    if (!named) { found.push(`imports ${from} wholesale`); continue }
    for (const spec of named[1].split(',')) {
      const name = spec.trim().replace(/^type\s+.*/, '').split(/\s+as\s+/)[0]
      if (MUTATOR.test(name)) found.push(`imports ${name}`)
    }
  }
  for (const [, from] of src.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (CORE.test(from) || WRITERS.test(from)) found.push(`loads ${from} dynamically`)
  }
  if (/^\s*['"]use server['"]/m.test(src)) found.push(`'use server' (a server action is a POST endpoint)`)
  if (/^route\.[cm]?[jt]sx?$/.test(path.basename(file))) {
    for (const m of NON_GET) {
      if (new RegExp(`export\\s+(async\\s+)?(function|const|let|var)\\s+${m}\\b|export\\s*\\{[^}]*\\b${m}\\b`).test(src)) {
        found.push(`exports ${m}`)
      }
    }
  }
  return found
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return SKIP.has(e.name) ? [] : sources(p)
    return /\.[cm]?[jt]sx?$/.test(e.name) ? [p] : []
  })
}

test('the web app imports no mutator and answers nothing but GET', () => {
  const files = sources(WEB)
  const rel = files.map((f) => path.relative(WEB, f))
  assert.ok(rel.includes(path.join('lib', 'vault.ts')), 'the scan reaches the data layer')
  assert.ok(rel.some((f) => f.endsWith(`${path.sep}route.ts`)), 'the scan reaches the route handlers')
  const bad = files.flatMap((f) => violations(f, fs.readFileSync(f, 'utf8')).map((v) => `${path.relative(WEB, f)}: ${v}`))
  assert.deepEqual(bad, [])
})

test('the guard catches each way around it', () => {
  const lib = path.join(WEB, 'lib', 'x.ts')
  const route = path.join(WEB, 'app', 'api', 'x', 'route.ts')
  const cases: [string, string, string[]][] = [
    [lib, `import { loadAll, setStatus as s } from '@knot-tui/core'`, ['imports setStatus']],
    [lib, `import {\n  claimTask,\n  type Task,\n} from '@knot-tui/core'`, ['imports claimTask']],
    [lib, `import { initConfig } from '@knot-tui/core'`, ['imports initConfig']],
    [lib, `export { deleteTask } from '@knot-tui/core'`, ['imports deleteTask']],
    [lib, `import { dropClaim } from '@knot-tui/core'`, ['imports dropClaim']],
    [lib, `import * as core from '@knot-tui/core'`, ['imports @knot-tui/core wholesale']],
    [lib, `import { addTodo } from '../../core/src/store.js'`, ['imports addTodo']],
    [lib, `const core = await import('@knot-tui/core')`, ['loads @knot-tui/core dynamically']],
    [lib, `import fs from 'node:fs'`, ['imports node:fs']],
    [lib, `'use server'\nexport async function act() {}`, [`'use server' (a server action is a POST endpoint)`]],
    [route, `export async function POST() {}`, ['exports POST']],
    [route, `export const DELETE = () => {}`, ['exports DELETE']],
    [route, `function PUT() {}\nexport { PUT }`, ['exports PUT']],
  ]
  for (const [file, src, want] of cases) assert.deepEqual(violations(file, src), want, src)

  const clean = `import { load, loadAll, type Task } from '@knot-tui/core'\nimport type { CreateTaskInput } from '@knot-tui/core'`
  assert.deepEqual(violations(lib, clean), [])
  assert.deepEqual(violations(route, `export async function GET() {}`), [])
})
