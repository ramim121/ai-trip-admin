import type { NextRequest } from 'next/server'
import { badRequest } from '@/server/http/errors'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { regenerateDay } from '@/server/modules/planner/itinerary'

/**
 * POST /api/v1/itineraries/{id}/days/{day}/regenerate — rebuild one day.
 *
 * Added deliberately alongside the specified endpoints: `regenerateDay` is a
 * required timeline operation, and an operation the API cannot reach is an
 * operation that does not exist. It is registered in the OpenAPI document like
 * every other route here.
 *
 * Two properties matter to a traveller pressing "try this day again". Locked
 * blocks survive — the day is planned around them, never over them. And the
 * activities already used on the OTHER days are excluded, so day 3 does not
 * quietly become day 1 again.
 *
 * A day beyond the entitlement is refused with the structured reason rather than
 * generated: day 5 of a FREE traveller's trip is precisely the wall the one-off
 * unlock exists to lift, and quietly filling it would give the product away.
 */
export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/itineraries/[id]/days/[day]/regenerate'>) => {
    const claims = await requireUser(req)
    const { id, day } = await ctx.params

    const dayNumber = Number(day)
    if (!Number.isInteger(dayNumber) || dayNumber < 1) {
      throw badRequest('The day must be a whole number, counting from 1.', [
        { path: 'day', message: 'Not a day number.' },
      ])
    }

    const result = await regenerateDay(claims.userId, id, dayNumber)

    return json({
      itinerary: result.itinerary,
      allowance: {
        maxDays: result.allowance.maxDays,
        unlimited: result.allowance.unlimited,
        unlocked: result.allowance.unlocked,
        source: result.allowance.source,
        refusal: result.allowance.refusal,
      },
      dayNumber: result.dayNumber,
    })
  }
)
