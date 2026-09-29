import { watch } from 'chokidar'
import { loadAll, type Store } from './store.js'
import type { Task } from './types.js'

/**
 * Calls `onChange` when a task file is added, changed or removed. The debounce is not
 * cosmetic: one editor save fires several events. `depth: 0` keeps an Obsidian
 * `.obsidian/` directory in the vault from retriggering on every workspace-state write.
 */
export function watchVault(store: Store, onChange: () => void, debounceMs = 80): () => void {
  let timer: NodeJS.Timeout | undefined
  const watcher = watch(store.dir, { ignoreInitial: true, depth: 0 })
  const schedule = (file: string) => {
    if (!file.endsWith('.md')) return
    clearTimeout(timer)
    timer = setTimeout(onChange, debounceMs)
  }
  watcher.on('add', schedule).on('change', schedule).on('unlink', schedule)
  return () => {
    clearTimeout(timer)
    void watcher.close()
  }
}

/** `watchVault`, handing over the reloaded tasks. */
export function watchTasks(store: Store, onChange: (tasks: Task[]) => void, debounceMs = 80): () => void {
  return watchVault(store, () => onChange(loadAll(store)), debounceMs)
}
