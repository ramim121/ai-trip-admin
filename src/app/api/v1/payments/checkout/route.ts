import type { NextRequest } from 'next/server'
import { clientContext, requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { CheckoutBody } from '@/server/payments/schema'
import { openCheckout } from '@/server/payments/service'

/**
 * POST /api/v1/payments/checkout — start a purchase.
 *
 * The body says WHAT is being bought. It does not, and cannot, say what it
 * costs: there is no amount field, `CheckoutBody` is a plain object schema so an
 * amount sent anyway is stripped before this handler runs, and the server reads
 * the price from the Plan row or the unlock-price setting on every call. A
 * client that sends `amountBdt: 1` is charged the real price and told so in the
 * response.
 *
 * Two purposes, and they are not interchangeable. `ITINERARY_UNLOCK` needs an
 * `itineraryId` you own and buys the full length of that one trip, forever;
 * `SUBSCRIPTION` needs a `planCode` naming a plan that is on sale AND has a
 * monthly interval. UNLOCK_SINGLE is refused as a subscription with a 400 — it
 * is a price, not a tier, and granting it as one would turn a single 200 BDT
 * payment into an account-wide upgrade.
 *
 * `redirectUrl` in the response points at the PUBLIC site, not at this API. Send
 * the browser there; the traveller pays, and the payment settles through the
 * provider's own completion route.
 *
 * 201 rather than 200: this creates a Payment row, and the id it returns is how
 * everything afterwards refers to it.
 */
export const POST = route(async (req: NextRequest) => {
  const claims = await requireUser(req)
  const body = await parseJson(req, CheckoutBody)

  return json(await openCheckout(claims.userId, body, clientContext(req)), 201)
})
