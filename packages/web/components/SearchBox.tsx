'use client'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

/** The TUI's `/`: fuzzy over titles and tags, `#tag` for tags only. Kept in `?q=`, so a search is a link. */
export function SearchBox() {
  const router = useRouter()
  const path = usePathname()
  const params = useSearchParams()
  const urlQuery = params.get('q') ?? ''
  const [value, setValue] = useState(urlQuery)
  const input = useRef<HTMLInputElement>(null)

  // Back and forward change the URL under the box; follow it unless someone is typing.
  useEffect(() => {
    if (document.activeElement !== input.current) setValue(urlQuery)
  }, [urlQuery])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      if ((e.target as HTMLElement | null)?.closest('input, textarea, [contenteditable]')) return
      e.preventDefault()
      input.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const search = (q: string) => {
    setValue(q)
    const next = new URLSearchParams(params)
    if (q.trim()) next.set('q', q)
    else next.delete('q')
    const query = next.toString()
    router.replace(query ? `${path}?${query}` : path, { scroll: false })
  }

  return (
    <input
      ref={input}
      className="search"
      type="search"
      value={value}
      placeholder="/ search   #tag"
      aria-label="Search tasks"
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => search(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        search('')
        e.currentTarget.blur()
      }}
    />
  )
}
