import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseQuery } from '@/server/http/validate'
import { PaymentListQuery } from '@/server/payments/schema'
import { listPayments } from '@/server/payments/service'

/**
 * GET /api/v1/me/payments — what this traveller has paid for.
 *
 * Under `/me` rather than `/payments` because the resource is the caller's own
 * history, not the payments collection. There is deliberately no parameter for
 * whose payments to list: the user id comes from the token and goes straight
 * into the WHERE clause, so there is nothing here to tamper with — the same
 * arrangement `GET /api/v1/itineraries` uses.
 *
 * Sandbox payments are INCLUDED, labelled by `isTest`. They granted real
 * entitlements, so omitting them would leave a traveller looking at an unlocked
 * trip with nothing in their history to explain it. Test rows get filtered in
 * the admin console and in revenue reporting, where the question being asked is
 * about money rather than about what somebody owns.
 *
 * `total` counts everything matching, ignoring `limit` and `offset`.
 */
export const GET = route(async (req: NextRequest) => {
  const claims = await requireUser(req)
  const query = parseQuery(new URL(req.url), PaymentListQuery)

  return json(await listPayments(claims.userId, query))
})
