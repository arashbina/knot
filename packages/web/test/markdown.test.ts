import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../components/Markdown.js'

const html = (md: string, inline = false) => renderToStaticMarkup(createElement(Markdown, { inline, children: md }))

test("the knot's [/] and [-] items render as ◐ and ⊘, not as literal markers", () => {
  const out = html('- [/] halfway\n- [-] dropped\n- plain')
  assert.match(out, /◐<\/span> <span[^>]*>halfway/)
  assert.match(out, /⊘<\/span> <span style="[^"]*line-through[^"]*">dropped/)
  assert.doesNotMatch(out, /\[[/-]\]/)
  assert.match(out, /<li>plain<\/li>/)
})

test('GFM task items are disabled checkboxes', () => {
  const boxes = html('- [ ] open\n- [x] done\n- [X] also done').match(/<input[^>]*>/g) ?? []
  assert.equal(boxes.length, 3)
  for (const box of boxes) assert.match(box, /disabled/)
})

test('raw HTML and script URLs never reach the page', () => {
  const out = html('<script>alert(1)</script>\n\nsome <b onclick="x()">bold</b>\n\n[click](javascript:alert(1))')
  assert.doesNotMatch(out, /<script|<b[ >]|onclick|javascript:/)
  assert.match(out, /click/)
})

test('inline keeps marks but no blocks, for a one-line todo', () => {
  const out = html('use **this** and `that`\n\n# not a heading', true)
  assert.match(out, /<strong>this<\/strong>/)
  assert.match(out, /<code>that<\/code>/)
  assert.doesNotMatch(out, /<p>|<h1>/)
})
