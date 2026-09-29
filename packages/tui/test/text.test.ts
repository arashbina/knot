import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCommand } from '../src/commands.js'
import { inline, renderMarkdown } from '../src/markdown.js'
import { highlight, lineWidth, strWidth, truncateLine, wrap } from '../src/text.js'

const plain = (lines: { text: string }[][]) => lines.map((l) => l.map((s) => s.text).join(''))

test('wrap never exceeds the width and keeps a hanging indent', () => {
  const lines = wrap([{ text: 'the quick brown fox jumps over the lazy dog' }], 12, [{ text: '• ' }])
  assert.deepEqual(plain(lines), ['• the quick', '  brown fox', '  jumps over', '  the lazy', '  dog'])
  for (const l of lines) assert.ok(lineWidth(l) <= 12)
})

test('wrap hard-splits a word longer than the line', () => {
  assert.deepEqual(plain(wrap([{ text: 'abcdefghij' }], 4)), ['abcd', 'efgh', 'ij'])
})

test('highlight styles exactly the matched letters, merging runs', () => {
  const segs = highlight('Beta task', [0, 2, 3], { color: 'fg' }, { color: 'hl', bold: true })
  assert.deepEqual(segs, [
    { color: 'hl', bold: true, text: 'B' },
    { color: 'fg', text: 'e' },
    { color: 'hl', bold: true, text: 'ta' },
    { color: 'fg', text: ' task' },
  ])
  assert.deepEqual(highlight('plain', [], { color: 'fg' }, { color: 'hl' }), [{ color: 'fg', text: 'plain' }])
})

test('wide characters count as two columns', () => {
  assert.equal(strWidth('日本'), 4)
  assert.equal(lineWidth(truncateLine([{ text: '日本語のテキスト' }], 7)), 7)
})

test('renderMarkdown emits one terminal line per entry, never wider than the pane', () => {
  const src = '# Title\n\nA paragraph that is long enough to wrap across several lines.\n\n- item one\n- [x] done item\n\n```\ncode line that is very very long indeed\n```\n\n> quoted text here'
  for (const width of [10, 20, 40]) {
    for (const line of renderMarkdown(src, width)) assert.ok(lineWidth(line) <= width, `${width}: ${JSON.stringify(line)}`)
  }
  const text = plain(renderMarkdown(src, 40))
  assert.equal(text[0], 'Title')
  assert.ok(text.includes('• item one'))
  assert.ok(text.includes('● done item'))
  assert.ok(text.some((l) => l.startsWith('│ quoted')))
})

test('soft-wrapped paragraph lines join before re-wrapping', () => {
  assert.deepEqual(plain(renderMarkdown('one\ntwo\nthree', 40)), ['one two three'])
})

test('inline styles: code, bold, links', () => {
  const segs = inline('run `npm test` then **ship** via [docs](https://x.y)')
  assert.deepEqual(segs.map((s) => s.text), ['run ', 'npm test', ' then ', 'ship', ' via ', 'docs'])
  assert.equal(segs[3].bold, true)
  assert.equal(segs[5].underline, true)
})

test('snake_case is not italic', () => {
  assert.deepEqual(inline('a_b_c').map((s) => s.text), ['a_b_c'])
})

test(':status accepts names, the wip alias and unambiguous prefixes', () => {
  assert.deepEqual(parseCommand('status wip'), { kind: 'status', status: 'in-progress' })
  assert.deepEqual(parseCommand('s done'), { kind: 'status', status: 'done' })
  assert.deepEqual(parseCommand('status bl'), { kind: 'status', status: 'blocked' })
  assert.deepEqual(parseCommand('status todo'), { kind: 'error', message: 'status: one of backlog, in-progress (wip), review, done, blocked (block)' })
  assert.equal(parseCommand('nope').kind, 'error')
  assert.deepEqual(parseCommand('cancel'), { kind: 'todo', state: 'cancelled' })
})
