import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { claimJourney, readJourney } from '@/server/modules/journey/service'
import { assembleJourneyView } from '@/server/modules/journey/view'

/**
 * POST /api/v1/journeys/{id}/claim — attach a plan to the account that just
 * signed in.
 *
 * THE OTHER HALF OF THE ANONYMOUS FUNNEL. A visitor parses a trip before they
 * have an account; the plan is created the moment they sign up, and this is what
 * carries it across the wall so nothing has to be retyped.
 *
 * Predicated on the journey having no owner, so a link somebody pasted cannot be
 * claimed out from under its owner — the update matches nothing and answers 409.
 */
export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]/claim'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    await claimJourney(id, claims.userId)

    return json(assembleJourneyView(await readJourney(id, claims.userId)))
  }
)
