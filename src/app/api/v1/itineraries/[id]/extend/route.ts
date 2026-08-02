import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { extendToEntitlement } from '@/server/modules/planner/itinerary'

/**
 * POST /api/v1/itineraries/{id}/extend — plan the days that have no plan.
 *
 * The traveller has a seven-day trip with two days built and wants the other
 * five. This adds only what is missing: days that already exist are left
 * exactly as they were left, blocks and all. Additive by construction — the
 * loop skips every day number that already has a row — so pressing it twice
 * cannot overwrite anything.
 *
 * IT REPORTS WHAT IT DID, AND THAT IS THE POINT OF THE RESPONSE SHAPE.
 * `addedDays` may legitimately come back empty, and the two ways that happens
 * need telling apart:
 *
 *   • Every day of the trip is already planned. Nothing to do, and saying so is
 *     a perfectly good answer.
 *   • The trip is seven days and the traveller's plan reaches two. Every day
 *     within reach already exists, so the loop adds nothing — and answering
 *     "all done" there would be a lie about a wall they just hit.
 *
 * `unreachableDays` separates them. Empty `addedDays` with a populated
 * `unreachableDays` is the second case, and the client renders the upgrade
 * offer that `allowance.refusal` already carries.
 *
 * NO MODEL CALLS HAPPEN HERE, despite the button saying "plan". Days are packed
 * from the activity catalogue by `packDay`, which is deterministic arithmetic —
 * the AI in this product writes the conversation and the anonymous teaser, not
 * itineraries. So this is metered for database work rather than token spend,
 * which is why the limit below is generous rather than tight.
 *
 * RATE LIMITED PER USER, not per itinerary. The work scales with the number of
 * missing days, so one press can create a dozen days and all their blocks, and
 * a loop calling this across several itineraries would be a cheap way to make
 * the database do a great deal of work. Six an hour sits far above deliberate
 * use and well below anything automated.
 */

/** Extends one account may run per hour. Generous for a person, tight for a script. */
export const EXTENDS_PER_USER_PER_HOUR = 6

export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/itineraries/[id]/extend'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    await enforceRateLimit(
      {
        key: `itinerary-extend:user:${claims.userId}`,
        limit: EXTENDS_PER_USER_PER_HOUR,
        windowSeconds: 60 * 60,
      },
      'That is a lot of planning at once. Try again shortly.'
    )

    // Ownership lives in the service's WHERE clause — a stranger's itinerary
    // answers 404 here, indistinguishable from one that does not exist.
    const result = await extendToEntitlement(claims.userId, id)

    return json({
      itinerary: result.itinerary,
      addedDays: result.addedDays,
      unreachableDays: result.unreachableDays,
      allowance: {
        maxDays: result.allowance.maxDays,
        unlimited: result.allowance.unlimited,
        unlocked: result.allowance.unlocked,
        source: result.allowance.source,
        refusal: result.allowance.refusal,
      },
    })
  }
)
