import { NotFoundError } from '@knot-tui/core'

/** A missing vault: 503 with the one-line reason. Anything else is a real bug and rethrows. */
export function vaultMissing(e: unknown): Response {
  if (e instanceof NotFoundError) return Response.json({ error: e.message }, { status: 503 })
  throw e
}
