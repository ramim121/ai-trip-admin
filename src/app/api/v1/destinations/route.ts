import type { NextRequest } from 'next/server'
import { json, route } from '@/server/http/handler'
import { parseQuery } from '@/server/http/validate'
import { DestinationListQuery, toPublicDestination } from '@/server/modules/catalog/schema'
import { listDestinations } from '@/server/modules/catalog/service'

/**
 * GET /api/v1/destinations — everywhere Beyond Borders sells.
 *
 * Public and unauthenticated. This is the top of the catalog: the website's
 * browse page starts here, and so does the planner, because a `slug` from this
 * response is what the activities endpoint takes.
 *
 * Retired destinations are absent rather than flagged. A client handed
 * `isActive: false` rows would have to remember to filter them, and one day one
 * of them would not.
 *
 * `activityCount` counts published activities only. Advertising a destination
 * with eleven things to do when three of them are unpublished drafts is a
 * promise ops cannot keep.
 */
export const GET = route(async (req: NextRequest) => {
  const query = parseQuery(new URL(req.url), DestinationListQuery)

  const destinations = await listDestinations({ query: query.q })

  return json({ destinations: destinations.map(toPublicDestination) })
})
