import { vaultMissing } from '../../../lib/http.js'
import { listJson } from '../../../lib/vault.js'

export const dynamic = 'force-dynamic'

export function GET() {
  try { return Response.json(listJson()) }
  catch (e) { return vaultMissing(e) }
}
