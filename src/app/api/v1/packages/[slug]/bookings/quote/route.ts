import type { NextRequest } from 'next/server'
import { optionalUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { QuoteBody, toQuoteResponse } from '@/server/modules/bookings/schema'
import { quoteDeparture } from '@/server/modules/bookings/service'

/**
 * POST /api/v1/packages/{slug}/bookings/quote — what would this cost?
 *
 * A read that happens to take a body, because it takes three inputs and one of
 * them is a promo code somebody is typing. It writes nothing: no booking, no
 * redemption, no seat held.
 *
 * A REFUSED CODE STILL RETURNS A PRICE. `couponRefusal` is populated and the
 * total is the undiscounted one. Answering 400 would blank the price while
 * somebody is mid-typo, which is the opposite of helpful — and the booking call
 * refuses the same code properly, so nothing can be bought at the wrong price.
 *
 * No session required. Somebody deciding whether a trip is affordable has not
 * signed in yet, and the per-account coupon ceiling simply does not bind for
 * them — see `evaluateCoupon` for why that is a stated hole rather than a
 * forgotten one.
 */
export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/packages/[slug]/bookings/quote'>) => {
    const { slug } = await ctx.params
    const body = await parseJson(req, QuoteBody)
    const claims = await optionalUser(req)

    const quote = await quoteDeparture({
      slug,
      departureId: body.departureId,
      partySize: body.partySize,
      couponCode: body.couponCode ?? null,
      userId: claims?.userId ?? null,
    })

    return json(toQuoteResponse(quote))
  }
)
