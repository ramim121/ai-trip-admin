import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { getItinerary, updateItinerary } from '@/server/modules/planner/itinerary'
import { UpdateItineraryBody } from '@/server/modules/planner/schema'

/**
 * GET /api/v1/itineraries/{id} — one trip, in full, with its conflicts.
 *
 * PATCH /api/v1/itineraries/{id} — edit the trip's own fields.
 *
 * Both are scoped to the owner inside the query. Somebody else's itinerary
 * answers 404 rather than 403, so an id cannot be probed for existence.
 *
 * Two PATCH fields ripple further than they look. Moving `startDate` re-dates
 * every day, which changes the weekday each one falls on and therefore which
 * opening-hours warnings apply. Changing `transportPreference` re-estimates
 * every transfer we drew — and only the ones we drew; a ferry the traveller
 * typed in themselves stays exactly where it is. Both are why the whole
 * itinerary comes back rather than an acknowledgement.
 */
export const GET = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/itineraries/[id]'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    return json(await getItinerary(claims.userId, id))
  }
)

export const PATCH = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/itineraries/[id]'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params
    const body = await parseJson(req, UpdateItineraryBody)

    return json(await updateItinerary(claims.userId, id, body))
  }
)
