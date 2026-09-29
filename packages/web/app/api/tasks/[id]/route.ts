import { vaultMissing } from '../../../../lib/http.js'
import { showJson } from '../../../../lib/vault.js'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: RouteContext<'/api/tasks/[id]'>) {
  const { id } = await ctx.params
  let task
  try { task = showJson(id) }
  catch (e) { return vaultMissing(e) }
  return task ? Response.json(task) : Response.json({ error: `no task ${id}` }, { status: 404 })
}
