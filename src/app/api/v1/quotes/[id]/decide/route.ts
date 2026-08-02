import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { DecideQuoteBody, toQuoteView } from '@/server/modules/quotes/schema'
import { decideQuote } from '@/server/modules/quotes/service'

/**
 * POST /api/v1/quotes/{id}/decide — accept or decline what was quoted.
 *
 * The decision is a conditional UPDATE predicated on the quote still being
 * SENT, so a double-click, or a click racing an ops withdrawal, resolves to one
 * decision rather than to whichever write landed last. A second attempt answers
 * 409 with a sentence rather than silently overwriting the first.
 *
 * ACCEPTING TAKES NO MONEY. It records agreement and moves the itinerary to
 * ACCEPTED; paying is the commerce module's job and a separate, deliberate act.
 * Collapsing the two would mean a single click both agreeing a price and
 * charging for it.
 */
export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/quotes/[id]/decide'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    const body = await parseJson(req, DecideQuoteBody)

    // Ownership is in the service's WHERE clause; somebody else's quote is
    // indistinguishable from one that does not exist.
    const quote = await decideQuote(claims.userId, id, body.accept)

    return json(toQuoteView(quote))
  }
)
