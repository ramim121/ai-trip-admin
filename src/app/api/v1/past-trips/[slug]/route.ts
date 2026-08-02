import { notFound } from '@/server/http/errors'
import { json, route } from '@/server/http/handler'
import { toPublicPastTrip } from '@/server/modules/past-trips/schema'
import { getPastTrip } from '@/server/modules/past-trips/service'

/**
 * GET /api/v1/past-trips/{slug} — one trip, as it actually went.
 *
 * The whole record in one response: the story, the highlights — incidents
 * included — the approved gallery, every approved review with its own scores,
 * and the per-dimension averages computed from exactly those reviews.
 *
 * Averaged from the same rows the response carries rather than by a second
 * query, so the summary at the top cannot disagree with the individual scores
 * printed underneath it.
 *
 * Unapproved photographs and reviews are absent rather than flagged, and the
 * participant list is not published at all: `memberCount` says how many people
 * came, and naming them would publish a social graph nobody agreed to.
 */
export const GET = route(async (_req, ctx: RouteContext<'/api/v1/past-trips/[slug]'>) => {
  const { slug } = await ctx.params

  const trip = await getPastTrip(slug)
  if (trip === null) throw notFound('No such trip.')

  return json({ trip: toPublicPastTrip(trip) })
})
