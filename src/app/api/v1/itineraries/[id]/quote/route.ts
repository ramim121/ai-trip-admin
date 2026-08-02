import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { parseJson } from '@/server/http/validate'
import { RequestQuoteBody, toQuoteView } from '@/server/modules/quotes/schema'
import { requestQuote } from '@/server/modules/quotes/service'

/**
 * POST /api/v1/itineraries/{id}/quote — ask what this trip would cost.
 *
 * Opens a conversation with ops rather than returning a price: nothing here is
 * computed, and the response carries no figures at all until somebody has
 * priced it by hand. That is the honest shape for a bespoke trip — an instant
 * number would be a guess presented as a quote.
 *
 * ONE OPEN QUOTE PER TRIP, so asking twice while ops is working answers 409
 * rather than opening a second conversation about the same itinerary. Asking
 * again after a decline is a genuinely new request and is allowed.
 *
 * Rate limited because each request lands in a human queue. The ceiling is
 * about ops attention rather than compute.
 */

/** Quote requests one account may open per hour. */
export const QUOTE_REQUESTS_PER_USER_PER_HOUR = 10

export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/itineraries/[id]/quote'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    await enforceRateLimit(
      {
        key: `quote-request:user:${claims.userId}`,
        limit: QUOTE_REQUESTS_PER_USER_PER_HOUR,
        windowSeconds: 60 * 60,
      },
      'That is a lot of quote requests at once. Give us a chance to answer.'
    )

    const body = await parseJson(req, RequestQuoteBody)

    // Ownership lives in the service's WHERE clause: a stranger's itinerary is
    // a 404 here, indistinguishable from one that does not exist.
    const quote = await requestQuote(claims.userId, id, body.note ?? null)

    return json(toQuoteView(quote), 201)
  }
)
