import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { toPublicBooking } from '@/server/modules/bookings/schema'
import { listMyBookings } from '@/server/modules/bookings/service'

/**
 * GET /api/v1/me/bookings — the traveller's own seats.
 *
 * No parameter says whose. The user id comes from the token and goes straight
 * into the query, exactly as on /me/payments — an endpoint that took an id
 * would be an endpoint somebody eventually passes somebody else's.
 *
 * Every booking carries the figures it was made with rather than today's price:
 * `unitPriceBdt`, `subtotalBdt`, `discountBdt` and `totalBdt` are snapshots, so
 * a receipt from March still says what March cost. `bookedAt` is when it was
 * made and `confirmedAt` is when the money landed — two different dates, and
 * the second is null while a booking is still awaiting payment.
 */
export const GET = route(async (req: NextRequest) => {
  const claims = await requireUser(req)

  const bookings = await listMyBookings(claims.userId)

  return json({ bookings: bookings.map(toPublicBooking) })
})
