import { restoreColorEnv } from './force-color.js' // must stay above the ink import
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'
import { render, type Instance } from 'ink'
import { loadConfig, openStore, type Store } from '@knot-tui/core'
import type { LaunchPlan } from '../packages/tui/src/launch.js'
import { Root } from '../packages/tui/src/root.js'

restoreColorEnv()

// Headless, a real editor would block forever on a TTY nobody is typing into — a
// stray `e` in a test would hang the suite. Tests that need one set `[editor] command`,
// which wins over these.
process.env.VISUAL = 'true'
process.env.EDITOR = 'true'

/**
 * Not ink-testing-library: it hardcodes a 100-column terminal and silently mangles
 * anything wider. This stub reports whatever size the test asks for.
 */
class StdoutStub extends EventEmitter {
  isTTY = true
  frames: string[] = []
  constructor(public columns: number, public rows: number) { super() }
  write(chunk: string) {
    this.frames.push(chunk)
    return true
  }
}

/** Drives both 'readable' (+ read()) and 'data', because Ink may listen for either. */
class StdinStub extends EventEmitter {
  isTTY = true
  private queue: string[] = []
  setRawMode() { return this }
  setEncoding() { return this }
  ref() { return this }
  unref() { return this }
  resume() { return this }
  pause() { return this }
  read() { return this.queue.shift() ?? null }
  send(data: string) {
    this.queue.push(data)
    this.emit('readable')
    this.emit('data', data)
  }
}

const SEQUENCES: Record<string, string> = {
  enter: '\r', esc: '\u001B', tab: '\t', 'shift+tab': '\u001B[Z', space: ' ', backspace: '\u007F',
  up: '\u001B[A', down: '\u001B[B', right: '\u001B[C', left: '\u001B[D',
}

/** Key names as the keymap spells them → the bytes a terminal would send. */
export function encodeKey(name: string): string {
  if (SEQUENCES[name]) return SEQUENCES[name]
  const ctrl = /^ctrl\+(.)$/.exec(name)
  if (ctrl) return String.fromCharCode(ctrl[1].toLowerCase().charCodeAt(0) & 0x1f)
  return name
}

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string) => s.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007]*\u0007/g, '')

/** The text between an ANSI frame's SGR codes, with the truecolor foreground (`r;g;b`, or '') and whether a background is set. */
function* styledText(ansi: string): Generator<{ text: string; fg: string; bg: boolean }> {
  let fg = ''
  let bg = false
  // eslint-disable-next-line no-control-regex
  for (const token of ansi.split(/(\u001B\[[0-9;]*m)/)) {
    // eslint-disable-next-line no-control-regex
    const sgr = /^\u001B\[([0-9;]*)m$/.exec(token)
    if (!sgr) {
      yield { text: token, fg, bg }
      continue
    }
    const params = sgr[1].split(';')
    for (let i = 0; i < params.length; i++) {
      if ((params[i] === '38' || params[i] === '48') && params[i + 1] === '2') {
        if (params[i] === '38') fg = params.slice(i + 2, i + 5).join(';')
        else bg = true
        i += 4
      } else if (params[i] === '0' || params[i] === '') {
        fg = ''
        bg = false
      } else if (params[i] === '39') {
        fg = ''
      } else if (params[i] === '49') {
        bg = false
      }
    }
  }
}

/** Runs of text printed in foreground colour `hex` (`#rrggbb`) within an ANSI frame or line. */
export function coloredRuns(ansi: string, hex: string): string[] {
  const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(';')
  const runs: string[] = []
  let run = ''
  const flush = () => {
    if (run) runs.push(run)
    run = ''
  }
  for (const { text, fg } of styledText(ansi)) {
    if (fg === want) run += text
    else if (text) flush()
  }
  flush()
  return runs
}

/** Visible characters printed with no background colour set — where the terminal's own background shows through. */
export function unpaintedText(ansi: string): string {
  let out = ''
  for (const { text, bg } of styledText(ansi)) if (!bg) out += text.replace(/\n/g, '')
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface Harness {
  store: Store
  /** Claude launches the TUI asked for. Recorded, never run: a headless test must not start real sessions. */
  launches: LaunchPlan[]
  /** The latest frame, with ANSI styling. */
  frame(): string
  /** The latest frame as plain text. */
  text(): string
  /** Press keys by name: `press('j', 'j', 'enter')`, `press('ctrl+u')`. */
  press(...keys: string[]): Promise<void>
  /** Type literal text into an inline editor, one key at a time. */
  type(text: string): Promise<void>
  unmount(): void
}

export interface HarnessOptions {
  dir: string
  cols?: number
  rows?: number
  /** Defaults to a path that doesn't exist, so the user's own config never leaks in. */
  configFile?: string
}

export async function startHarness({ dir, cols = 120, rows = 36, configFile }: HarnessOptions): Promise<Harness> {
  const file = configFile ?? path.join(os.tmpdir(), `knot-harness-${process.pid}-none.toml`)
  const store = openStore(dir)
  const stdout = new StdoutStub(cols, rows)
  const stdin = new StdinStub()
  const launches: LaunchPlan[] = []
  const launcher = async (plan: LaunchPlan) => {
    launches.push(plan)
    return `recorded launch of ${plan.label}`
  }
  const instance: Instance = render(
    <Root store={store} vault={store.dir} configFile={file} initialConfig={loadConfig(file)} watch={false} launcher={launcher} claimPollMs={50} />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await sleep(20)

  const press = async (...keys: string[]) => {
    for (const key of keys) {
      stdin.send(encodeKey(key))
      // A lone ESC is held briefly by Ink's parser to tell it apart from an escape sequence.
      await sleep(key === 'esc' ? 40 : 8)
    }
  }

  return {
    store,
    launches,
    frame: () => stdout.frames.at(-1) ?? '',
    text: () => stripAnsi(stdout.frames.at(-1) ?? ''),
    press,
    type: (text) => press(...Array.from(text)),
    unmount: () => instance.unmount(),
  }
}

export function tempDir(prefix = 'knot-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}
