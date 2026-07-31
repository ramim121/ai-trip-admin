import type { NextRequest } from 'next/server'
import { notFound } from '@/server/http/errors'
import { json, route } from '@/server/http/handler'
import { parseQuery } from '@/server/http/validate'
import {
  ActivitySearchQuery,
  toPublicDestination,
  toRankedActivitySummary,
} from '@/server/modules/catalog/schema'
import { getDestinationBySlug, searchActivities } from '@/server/modules/catalog/service'

/**
 * GET /api/v1/destinations/{slug}/activities — what there is to do somewhere.
 *
 * Public and unauthenticated, and the same ranked search the AI planner runs
 * through its `searchActivities` tool. One implementation, deliberately: if the
 * website and the planner ranked differently, a traveller would see one order
 * while browsing and another while planning, and neither of us could say which
 * was right.
 *
 * The destination is resolved first and separately. Filtering activities by slug
 * alone would answer `200 { activities: [] }` for a place we have never heard
 * of, which reads as "we go there, there is just nothing to do" — the opposite
 * of true. An unknown slug and a retired destination both 404, and identically,
 * so neither can be told from the other.
 *
 * `total` is what passed the filters, before `limit`. There is no cursor: this
 * is a curated catalog of tens of activities per destination, and a pagination
 * contract we would have to honour forever is not worth inventing for that.
 */
export const GET = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/destinations/[slug]/activities'>) => {
    const { slug } = await ctx.params
    const query = parseQuery(new URL(req.url), ActivitySearchQuery)

    const destination = await getDestinationBySlug(slug)
    if (destination === null) throw notFound('No such destination.')

    const result = await searchActivities({
      destinationId: destination.id,
      interests: query.interests,
      category: query.category,
      timeOfDay: query.timeOfDay,
      maxDurationMinutes: query.maxDurationMinutes,
      maxPricePerPersonBdt: query.maxPricePerPersonBdt,
      partySize: query.partySize,
      limit: query.limit,
    })

    return json({
      destination: toPublicDestination(destination),
      activities: result.activities.map(toRankedActivitySummary),
      total: result.matched,
      truncated: result.truncated,
    })
  }
)
