import type { NextRequest } from 'next/server'
import { json, route } from '@/server/http/handler'
import { readJourneyByToken } from '@/server/modules/journey/service'
import { assembleJourneyView } from '@/server/modules/journey/view'

/**
 * GET /api/v1/shared-journeys/{token} — a plan by its share link.
 *
 * NO AUTHENTICATION, BY DESIGN. Every shared link is free distribution: a
 * co-traveller opens it on their phone from WhatsApp, sees the plan, and no
 * account stands between them and it.
 *
 * READ-ONLY BY CONSTRUCTION, not by a flag. No write path anywhere accepts a
 * token — editing goes through the journey routes, which require a user id the
 * service checks against the row. So the worst a leaked link can do is show
 * somebody a holiday.
 *
 * THE TOKEN IS THE ONLY PROTECTION, which is why it is 144 bits of randomness
 * and why a CHECK constraint refuses anything shorter than twenty characters.
 * It is deliberately not on a separate path from `/journeys/{id}`: an id is
 * guessable in a way a token is not, and mixing them would let somebody try ids
 * against an unauthenticated endpoint.
 */
export const GET = route(
  async (_req: NextRequest, ctx: RouteContext<'/api/v1/shared-journeys/[token]'>) => {
    const { token } = await ctx.params

    const journey = await readJourneyByToken(token)
    const view = assembleJourneyView(journey)

    // The contact details belong to whoever asked for the quotation, not to
    // whoever holds the link. A share is for showing somebody the trip.
    return json({ ...view, shareToken: token })
  }
)
