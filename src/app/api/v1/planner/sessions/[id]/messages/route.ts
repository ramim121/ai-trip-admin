import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { claimPrompt, entitlementRefused, userActor } from '@/server/modules/entitlements/service'
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
 * The prompt quota is settled here rather than inside the streaming service
 * because it is an entitlement question and not an AI one: the entitlement
 * module knows about billing periods, and `chat.ts` deliberately knows only
 * about tokens.
 *
 * Note `claimPrompt`, not `canPrompt`. The allowance is CLAIMED before the model
 * is called, not merely read: a read leaves a window between the check and the
 * increment as wide as the 45-second wall-clock timeout, and every request
 * arriving inside it sees the same pre-claim count. Five hundred concurrent
 * turns would all pass a thirty-turn ceiling and all bill a real call. The claim
 * puts the ceiling in a WHERE clause and lets Postgres settle the race.
 *
 * The rate limit is a second, independent bound. The claim caps what a period
 * costs; the limit caps how fast it can be spent, which is what stops a burst
 * from opening hundreds of concurrent upstream requests at once.
 */
const PLANNER_TURNS_PER_HOUR = 60

export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/planner/sessions/[id]/messages'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params
    const body = await parseJson(req, PlannerMessageBody)

    const actor = userActor(claims.userId)

    // Ownership first: an unauthorised caller must not learn anything about
    // their own quota, or about whether this session exists.
    const session = await loadSession(actor, id)

    await enforceRateLimit(
      {
        key: `planner:turn:user:${claims.userId}`,
        limit: PLANNER_TURNS_PER_HOUR,
        windowSeconds: 3600,
      },
      'You are sending messages faster than we can plan. Give it a moment and try again.'
    )

    const decision = await claimPrompt(claims.userId)
    if (!decision.allowed) throw entitlementRefused(decision.refusal)

    return streamPlannerTurn({ actor, session, text: body.text })
  }
)
