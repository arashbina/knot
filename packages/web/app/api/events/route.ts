import { subscribe } from '../../../lib/events.js'
import { vaultMissing } from '../../../lib/http.js'

export const dynamic = 'force-dynamic'

/** Idle proxies and sleeping laptops drop quiet streams; a comment now and then also finds dead clients. */
const HEARTBEAT_MS = 30_000

/** Server-Sent Events: one `data: tasks|claims` message per change. The page refetches on each. */
export function GET(req: Request) {
  const encoder = new TextEncoder()
  let push = (_text: string) => {}
  let unsubscribe: () => void
  try { unsubscribe = subscribe((change) => push(`data: ${change}\n\n`)) }
  // Not a 200, so EventSource gives up instead of retrying every second.
  catch (e) { return vaultMissing(e) }

  let heartbeat: NodeJS.Timeout | undefined
  let open = true
  const close = () => {
    if (!open) return
    open = false
    clearInterval(heartbeat)
    unsubscribe()
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (text) => {
        if (!open) return
        try { controller.enqueue(encoder.encode(text)) }
        catch { close() }
      }
      heartbeat = setInterval(() => push(': ping\n\n'), HEARTBEAT_MS)
      push('retry: 1000\n\n')
    },
    cancel: close,
  })
  req.signal.addEventListener('abort', close)
  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' },
  })
}
