import type { NextRequest } from 'next/server'
import { clientContext, requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { MockCompletionBody } from '@/server/payments/schema'
import { completeMockPayment } from '@/server/payments/service'

/**
 * POST /api/v1/payments/mock/{paymentId}/complete — the sandbox's "pay" button.
 *
 * Stands in for the callback a real gateway would send. The traveller presses
 * Pay, Decline or Cancel on the simulated checkout page, the browser posts the
 * outcome here, and on SUCCESS the entitlement is granted in the same
 * transaction that flips the payment to SUCCEEDED.
 *
 * SAFE TO CALL TWICE, and clients are expected to. The settlement is a
 * conditional update predicated on the current status, so a second completion
 * matches no row, grants nothing, and answers with exactly the body the first
 * one did — including the same `grant`, which is read back from the entitlement
 * rather than reported by the settlement. A double-clicked Pay button therefore
 * buys one unlock, not two.
 *
 * SCOPED THREE WAYS, all in one query: the payment must exist, must belong to
 * the caller, and must have been created by the sandbox. The third condition is
 * what stops this route settling a real bKash payment nobody paid for — and all
 * three failures answer 404 together, because "not yours" and "not a sandbox
 * payment" are distinctions the caller has no business drawing.
 *
 * Refuses outright with a 403 naming both PAYMENTS_MOCK_ENABLED and
 * PAYMENTS_ALLOW_MOCK_IN_PRODUCTION when the sandbox is not permitted here,
 * which under NODE_ENV=production is the default.
 *
 * Every call is audited as `payment.mock_settled`, replays included — those
 * carry `alreadySettled: true`, which is how a double-submitting client becomes
 * visible in the audit trail instead of in the revenue figures.
 */
export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/payments/mock/[paymentId]/complete'>) => {
    const claims = await requireUser(req)
    const { paymentId } = await ctx.params
    const body = await parseJson(req, MockCompletionBody)

    return json(
      await completeMockPayment(claims.userId, paymentId, body.outcome, clientContext(req))
    )
  }
)
