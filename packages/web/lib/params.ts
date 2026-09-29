// What a view's URL carries, so every view is linkable: `?q=…` is the `/` search,
// `?done=0|1` hides or shows done tasks. Pure, so client and server agree.

export interface ViewParams {
  q: string
  /** Show done tasks; undefined defers to `[ui] hide-done`. */
  done?: boolean
}

export type Search = Record<string, string | string[] | undefined>

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export function readParams(search: Search): ViewParams {
  const done = first(search.done)
  return { q: first(search.q) ?? '', done: done === '1' ? true : done === '0' ? false : undefined }
}

export function toQuery(p: ViewParams): string {
  const s = new URLSearchParams()
  if (p.q) s.set('q', p.q)
  if (p.done !== undefined) s.set('done', p.done ? '1' : '0')
  const q = s.toString()
  return q ? `?${q}` : ''
}

export function taskHref(id: string, p: ViewParams): string {
  return `/tasks/${encodeURIComponent(id)}${toQuery(p)}`
}
