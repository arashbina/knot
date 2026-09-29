import React from 'react'
import { render } from 'ink'
import { configPath, loadConfig, openStore, resolveVault } from '@knot-tui/core'
import { buildKeymap } from './keys.js'
import { Root } from './root.js'
import { ensureWelcome, mayCreateVault } from './welcome.js'

const configFile = configPath()
const loaded = loadConfig(configFile)
const vault = resolveVault(loaded)

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('knot: the TUI needs an interactive terminal — use `knot` for scripting')
  process.exit(1)
}

const create = mayCreateVault(loaded)
// A vault the welcome can't be written to still opens; its error only matters if it can't.
let welcomeError: unknown
try {
  ensureWelcome(vault, buildKeymap(loaded.config.keys).keys, { create })
} catch (e) {
  welcomeError = e
}

let store
try {
  store = openStore(vault)
} catch (e) {
  const why = welcomeError ?? e
  const hint = create ? '' : loaded.error ? ` — fix the config (${loaded.path}), or create the folder` : ' — fix KNOT_DIR / [vault] dir, or create the folder'
  console.error(`knot: ${why instanceof Error ? why.message : why}${hint}`)
  process.exit(2)
}

const app = render(
  <Root store={store} vault={store.dir} configFile={configFile} initialConfig={loaded} />,
  { alternateScreen: true },
)
await app.waitUntilExit()
