import { json, route } from '@/server/http/handler'
import { toPublicPastTripSummary } from '@/server/modules/past-trips/schema'
import { listPastTrips } from '@/server/modules/past-trips/service'

/**
 * GET /api/v1/past-trips — the trips we have already run.
 *
 * Public and unauthenticated. Published rows only, and the filter is a WHERE
 * clause rather than something a client is trusted to apply.
 *
 * Ordered most recent first by the date the trip STARTED, not the date it was
 * written up. A trip published six months late is still a trip from six months
 * ago, and somebody scanning this list is reading a timeline.
 *
 * Each card carries `overallAverage` — the one place a single figure is
 * computed, and computed as a mean of the per-axis means so a question few
 * people answered cannot swing it. The detail endpoint does not lead with that
 * number; it carries the seven axes separately, which is the honest form.
 */
export const GET = route(async () => {
  const trips = await listPastTrips()

  return json({ trips: trips.map(toPublicPastTripSummary) })
})
