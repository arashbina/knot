import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
/** Generated, or local-only at the top level (the vault in tasks/, agent config in .claude/): never source. */
const skip = (dir: string, name: string) =>
  name === 'node_modules' || name === '.next' || (dir === ROOT && (name === '.git' || name === 'tasks' || name === '.claude'))
/** Agents' local notes (CLAUDE.md, and next dev's AGENTS.md) are gitignored on purpose. */
const LOCAL_NOTES = new Set(['CLAUDE.md', 'AGENTS.md'])

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return skip(dir, e.name) ? [] : sources(p)
    return /\.(tsx?|css|md|json|mjs)$/.test(e.name) && e.name !== 'next-env.d.ts' && !LOCAL_NOTES.has(e.name) ? [p] : []
  })
}

// The vault's `tasks/` rule once matched every directory named tasks, which quietly
// kept the web app's task page and API routes out of the repo.
test('no source file is gitignored', (t) => {
  if (spawnSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT }).status !== 0) return t.skip('not a git checkout')
  const files = sources(ROOT).map((f) => path.relative(ROOT, f))
  assert.ok(files.some((f) => f.startsWith('packages/web/app/tasks/')), 'the walk reaches the web app')
  const r = spawnSync('git', ['check-ignore', '--stdin'], { cwd: ROOT, input: files.join('\n'), encoding: 'utf8' })
  assert.equal(r.stdout, '', `ignored by .gitignore:\n${r.stdout}`)
})
