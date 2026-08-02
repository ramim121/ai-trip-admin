import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { parseJson } from '@/server/http/validate'
import { CreateBookingBody } from '@/server/modules/bookings/schema'
import { createBooking } from '@/server/modules/bookings/service'

/**
 * POST /api/v1/packages/{slug}/bookings — hold the seats.
 *
 * Creates a booking in PENDING_PAYMENT and claims its seats immediately, before
 * anybody pays. Send the returned `bookingId` to /api/v1/payments/checkout with
 * `purpose: BOOKING` to open a payment; settlement confirms it.
 *
 * A SESSION IS REQUIRED HERE, unlike the interest list.
 *
 * Registering interest is a lead and costs nothing to get wrong. This holds
 * inventory and creates something that will be charged, so it needs an owner —
 * somebody to show the booking to afterwards, somebody the per-account coupon
 * ceiling can bind against, and somebody to refund. An anonymous seat hold is
 * also free denial-of-service against a departure.
 *
 * The rate limit is the second half of that. An account is cheap to create, so
 * one traveller opening ten bookings they never pay for would empty a bus just
 * as effectively; a handful an hour is far above any honest use.
 *
 * 201, and the body carries every figure: unit price, subtotal, discount and
 * total. The client renders exactly what the server decided rather than its own
 * arithmetic, which is the only way the two are guaranteed to agree.
 */

/** Bookings one account may open per hour. Generous for a person, tight for a loop. */
export const BOOKINGS_PER_USER_PER_HOUR = 6

export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/packages/[slug]/bookings'>) => {
    const { slug } = await ctx.params
    const claims = await requireUser(req)

    await enforceRateLimit(
      {
        key: `bookings:user:${claims.userId}`,
        limit: BOOKINGS_PER_USER_PER_HOUR,
        windowSeconds: 60 * 60,
      },
      'Too many bookings started. Finish or cancel one before opening another.'
    )

    const body = await parseJson(req, CreateBookingBody)

    const created = await createBooking({
      slug,
      departureId: body.departureId,
      partySize: body.partySize,
      contactName: body.contactName,
      contactEmail: body.contactEmail,
      contactPhone: body.contactPhone ?? null,
      notes: body.notes ?? null,
      couponCode: body.couponCode ?? null,
      userId: claims.userId,
    })

    return json(created, 201)
  }
)
