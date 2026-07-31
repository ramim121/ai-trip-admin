import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { userActor } from '@/server/modules/entitlements/service'
import { listMessages, loadSession } from '@/server/modules/planner/session'
import { toPlannerSessionView } from '@/server/modules/planner/views'

/**
 * GET /api/v1/planner/sessions/{id} — one conversation, with its history.
 *
 * Ownership is enforced inside `loadSession`, as part of the query rather than
 * as a check after it, so there is no path here that reads somebody else's
 * session at all. A session belonging to another traveller answers 404, not 403:
 * "not yours" and "does not exist" have to be indistinguishable, or this becomes
 * a way to discover which session ids are real.
 */
export const GET = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/planner/sessions/[id]'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    const session = await loadSession(userActor(claims.userId), id)
    const messages = await listMessages(session.id)

    return json(toPlannerSessionView(session, true, messages))
  }
)
