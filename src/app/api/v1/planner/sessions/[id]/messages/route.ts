import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { canPrompt, entitlementRefused, userActor } from '@/server/modules/entitlements/service'
import { streamPlannerTurn } from '@/server/modules/planner/chat'
import { PlannerMessageBody } from '@/server/modules/planner/schema'
import { loadSession } from '@/server/modules/planner/session'

/**
 * POST /api/v1/planner/sessions/{id}/messages — say something, and stream the reply.
 *
 * The response is `text/event-stream`, one JSON object per `data:` frame. See
 * `PlannerStreamEvent` for the shapes; `done` is always the last frame unless
 * the connection dropped.
 *
 * Everything that could refuse the turn is settled before the first byte is
 * written — ownership, the prompt quota, the session token budget — so a refusal
 * arrives as an ordinary 4xx in the standard error envelope. A 200 whose body
 * turns out to contain an error is far harder for a client to handle and
 * impossible to retry cleanly.
 *
 * The prompt quota is checked here rather than inside the streaming service
 * because it is an entitlement question and not an AI one: `canPrompt` knows
 * about billing periods, and `chat.ts` deliberately knows only about tokens.
 */
export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/planner/sessions/[id]/messages'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params
    const body = await parseJson(req, PlannerMessageBody)

    const actor = userActor(claims.userId)

    // Ownership first: an unauthorised caller must not learn anything about
    // their own quota, or about whether this session exists.
    const session = await loadSession(actor, id)

    const decision = await canPrompt(actor)
    if (!decision.allowed) throw entitlementRefused(decision.refusal)

    return streamPlannerTurn({ actor, session, text: body.text })
  }
)
