import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { readComparison } from '@/server/modules/journey/quotation'
import { toComparisonView } from '@/server/modules/journey/schema'
import { summariseBudget } from '@/server/modules/journey/service'

/**
 * GET /api/v1/journeys/{id}/comparison — what they planned, beside what it costs.
 *
 * THE OTHER HALF OF THE ADMIN WORKBENCH. Ops put a real vendor and a real price
 * against each line; this is the traveller seeing both columns, which is the
 * whole argument for the product. A quotation arriving as one number asks
 * somebody to trust it. One arriving as fifteen lines, each beside the thing
 * they chose and the estimate they were shown, can be read.
 *
 * ITEMS OPS DID NOT QUOTE FOR ARE VISIBLE AS ABSENCES. A row whose `quoted` is
 * null says "we are not pricing this", shown deliberately, because the
 * alternative is a traveller discovering it at the airport.
 *
 * OWNERSHIP IS A WHERE CLAUSE, as everywhere here, and a mismatch answers 404
 * rather than 403 — "not yours" and "does not exist" must look identical from
 * outside, or the endpoint becomes a way to enumerate real plans.
 *
 * NOT AVAILABLE BY SHARE TOKEN. A share link shows a friend the holiday; what it
 * costs is between the traveller and us.
 */
export const GET = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]/comparison'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    const comparison = await readComparison(id, claims.userId)

    /*
     * The estimate total is computed here through the same function the budget
     * meter uses, rather than being carried on the service's return.
     *
     * Two implementations of "what did they think this would cost" is two
     * numbers that eventually disagree — and this is the one screen where a
     * discrepancy reads as us having moved the goalposts.
     */
    const estimate = summariseBudget(
      comparison.journey,
      comparison.rows.map((row) => row.item)
    )

    return json(toComparisonView(comparison, estimate))
  }
)
