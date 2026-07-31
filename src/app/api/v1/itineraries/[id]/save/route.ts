import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { saveItinerary } from '@/server/modules/planner/itinerary'

/**
 * POST /api/v1/itineraries/{id}/save — keep this trip.
 *
 * A DRAFT is work in progress and occupies no allowance; saving is what claims
 * one of the free tier's three slots. That is why the check lives here rather
 * than at creation — a traveller who tries four ideas and keeps three has not
 * exceeded anything.
 *
 * Re-saving an itinerary that is already kept is a no-op that succeeds. It is
 * not a fourth of three, and refusing it would leave an account at its cap
 * unable to touch the trips it already has.
 *
 * A refusal is a 403 carrying `details[].path = "reason"` with the
 * machine-readable code — `SAVE_LIMIT` or `PERIOD_LIMIT`. Branch on that, never
 * on the message, and read the matching offer from GET /api/v1/me/entitlements.
 */
export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/itineraries/[id]/save'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    return json(await saveItinerary(claims.userId, id))
  }
)
