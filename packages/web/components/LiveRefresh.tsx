'use client'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

/** Re-renders the page from disk whenever a task file or a claim changes (`/api/events`). */
export function LiveRefresh() {
  const router = useRouter()
  useEffect(() => {
    const events = new EventSource('/api/events')
    let dropped = false
    events.onmessage = () => router.refresh()
    events.onerror = () => { dropped = true }
    // Anything could have changed while the server was away.
    events.onopen = () => {
      if (dropped) router.refresh()
      dropped = false
    }
    return () => events.close()
  }, [router])
  return null
}
