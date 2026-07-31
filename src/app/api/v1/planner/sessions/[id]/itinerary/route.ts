import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { userActor } from '@/server/modules/entitlements/service'
import { createItineraryFromBrief } from '@/server/modules/planner/itinerary'
import { MaterialiseItineraryBody } from '@/server/modules/planner/schema'
import { loadSession } from '@/server/modules/planner/session'

/**
 * POST /api/v1/planner/sessions/{id}/itinerary — turn the brief into a real trip.
 *
 * Answers 201 with the itinerary AND the day allowance beside it. That pairing
 * is the product rule: a FREE traveller who asked for seven days gets a real,
 * genuinely good two-day plan plus a `refusal` explaining the rest and what
 * would lift it. Not a 403, and not a silent two-day answer that pretends
 * nothing was cut.
 *
 * The `days` field in the body is a request, not an instruction. The entitlement
 * decides the length, and `generatedDays` is what actually happened — compare it
 * with `requestedDays` to know whether a wall was reached.
 */
export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/planner/sessions/[id]/itinerary'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params
    const body = await parseJson(req, MaterialiseItineraryBody)

    const session = await loadSession(userActor(claims.userId), id)

    const result = await createItineraryFromBrief({
      userId: claims.userId,
      brief: session.tripBrief,
      plannerSessionId: session.id,
      ...(body.days !== undefined ? { requestedDays: body.days } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
    })

    return json(
      {
        itinerary: result.itinerary,
        // Only the fields the contract publishes. `allowance.entitlement`
        // carries the whole snapshot, which belongs to GET /me/entitlements
        // rather than being echoed from every generation.
        allowance: {
          maxDays: result.allowance.maxDays,
          unlimited: result.allowance.unlimited,
          unlocked: result.allowance.unlocked,
          source: result.allowance.source,
          refusal: result.allowance.refusal,
        },
        requestedDays: result.requestedDays,
        generatedDays: result.generatedDays,
      },
      201
    )
  }
)
