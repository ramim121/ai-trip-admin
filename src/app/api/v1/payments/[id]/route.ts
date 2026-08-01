import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { readPayment } from '@/server/payments/service'

/**
 * GET /api/v1/payments/{id} — where has this payment got to?
 *
 * The polling endpoint. A client that sent the traveller off to a gateway has no
 * other way to learn what happened: the settlement arrives as a callback on the
 * server, not as a reply to anything the browser is holding open.
 *
 * Ownership is part of the query rather than a check performed afterwards, so
 * somebody else's payment answers 404 — the same answer an id that was never
 * issued gets, which is what stops this becoming a way to confirm that a guessed
 * id is real.
 *
 * While a payment is still in flight its status is confirmed with the provider
 * before being reported, rather than read from our row alone. Callbacks get
 * lost, and a traveller watching "pending" for a payment that cleared ten
 * minutes ago is how a support queue fills up. A terminal status is trusted as
 * it stands: nothing further happens to a SUCCEEDED payment without a refund,
 * which is its own operation.
 */
export const GET = route(async (req: NextRequest, ctx: RouteContext<'/api/v1/payments/[id]'>) => {
  const claims = await requireUser(req)
  const { id } = await ctx.params

  return json(await readPayment(claims.userId, id))
})
