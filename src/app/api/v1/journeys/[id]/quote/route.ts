import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { parseJson } from '@/server/http/validate'
import { RequestJourneyQuoteBody } from '@/server/modules/journey/schema'
import { requestQuotation } from '@/server/modules/journey/service'
import { assembleJourneyView } from '@/server/modules/journey/view'

/**
 * POST /api/v1/journeys/{id}/quote — send the plan for pricing.
 *
 * THE CONVERSION. Everything else in this product builds toward the traveller
 * feeling the plan is complete enough to send.
 *
 * NO PRICE COMES BACK. The response is the plan with its status moved, not a
 * figure — an instant number on a bespoke trip is a guess presented as a quote.
 * Ops prices it by hand through the same Quote tables the curated planner uses.
 *
 * Three gates, each with its own sentence: something planned, no unresolved
 * overlaps, no quote already open. The middle one is why conflicts exist at all.
 */

const QUOTE_REQUESTS_PER_USER_PER_HOUR = 10

export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]/quote'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    await enforceRateLimit(
      {
        key: `journey-quote:user:${claims.userId}`,
        limit: QUOTE_REQUESTS_PER_USER_PER_HOUR,
        windowSeconds: 60 * 60,
      },
      'That is a lot of quote requests at once. Give us a chance to answer.'
    )

    const body = await parseJson(req, RequestJourneyQuoteBody)

    const result = await requestQuotation(id, claims.userId, {
      whatsapp: body.whatsapp,
      email: body.email ?? null,
      preferredTime: body.preferredTime ?? null,
      notes: body.notes ?? null,
    })

    return json(assembleJourneyView(result.journey), 201)
  }
)
