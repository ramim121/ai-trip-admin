import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseQuery } from '@/server/http/validate'
import { listItineraries } from '@/server/modules/planner/itinerary'
import { ItineraryListQuery } from '@/server/modules/planner/schema'

/**
 * GET /api/v1/itineraries — the signed-in traveller's own trips.
 *
 * Summaries only. A list view returning every day and every block would ship
 * hundreds of kilobytes to render a dozen cards, and would make the practical
 * ceiling on page size a function of how detailed somebody's trips happen to be.
 *
 * There is no way to ask for anyone else's. The user id comes from the token and
 * goes straight into the WHERE clause — it is not a parameter, so there is
 * nothing here to tamper with.
 */
export const GET = route(async (req: NextRequest) => {
  const claims = await requireUser(req)
  const query = parseQuery(new URL(req.url), ItineraryListQuery)

  return json(await listItineraries(claims.userId, query))
})
