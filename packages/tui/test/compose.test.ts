import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTask } from '@knot-tui/core'
import { readComposed, updateTemplate } from '../src/compose.js'
import { DEFAULT_KEYS } from '../src/keys.js'

const task = parseTask('/v/t-008.md', "---\nid: t-008\ntitle: 'Flaky e2e test: checkout'\n---\n")

test('the $EDITOR template names the task and reads back empty when left untouched', () => {
  const template = updateTemplate(task)
  assert.match(template, /t-008/)
  assert.match(template, /Flaky e2e test: checkout/)
  assert.equal(readComposed(template), '')
})

test('what is written above the template comment is the update, trimmed', () => {
  const written = `\nFound the race.\n\n- retry removed\n${updateTemplate(task)}`
  assert.equal(readComposed(written), 'Found the race.\n\n- retry removed')
})

test("the writer's own HTML comments survive; only the template's is removed", () => {
  assert.equal(readComposed(`<!-- keep -->\nNote\n${updateTemplate(task)}`), '<!-- keep -->\nNote')
})

test('u adds a quick update, U composes one in $EDITOR', () => {
  assert.equal(DEFAULT_KEYS.u, 'update-add')
  assert.equal(DEFAULT_KEYS.U, 'update-edit')
})
