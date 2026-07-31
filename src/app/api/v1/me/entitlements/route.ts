import type { NextRequest } from 'next/server'
import { UserStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { unauthorized } from '@/server/http/errors'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { toEntitlementsResponse } from '@/server/modules/entitlements/schema'
import {
  canPrompt,
  canSaveItinerary,
  resolveEntitlement,
  userActor,
} from '@/server/modules/entitlements/service'

/**
 * GET /api/v1/me/entitlements — what this traveller may do, and how much of it
 * they have already done.
 *
 * The point of the endpoint is that a client should be able to explain a wall
 * before hitting it: grey out "save" with the right sentence attached, show
 * "3 of 3 saved", offer the one-off unlock at the moment it becomes the answer.
 * So the refusals are computed here and returned beside the limits, rather than
 * left to be discovered by a 403.
 *
 * None of this is authoritative for the client's benefit — it is a *report*.
 * Every mutating endpoint re-runs the same checks against the same tables, so a
 * client that ignores this response, caches it past a payment, or edits it in
 * the console gains exactly nothing. That is what makes it safe to publish the
 * numbers at all.
 *
 * Status is re-checked for the same reason `/auth/me` re-checks it: access
 * tokens are not revocable, so an account suspended thirty seconds ago is still
 * holding a valid one. A suspended account gets a 401, not a plan.
 */
export const GET = route(async (req: NextRequest) => {
  const claims = await requireUser(req)

  const user = await db.user.findUnique({
    where: { id: claims.userId },
    select: { status: true },
  })

  if (user === null || user.status !== UserStatus.ACTIVE) throw unauthorized()

  const actor = userActor(claims.userId)

  // Resolved once and threaded through both decisions. Letting each resolve for
  // itself would triple the query count and — worse — let the two answers
  // disagree if a payment settled between them.
  const entitlement = await resolveEntitlement(claims.userId)

  const [save, prompt] = await Promise.all([
    canSaveItinerary(actor, {}, entitlement),
    canPrompt(actor, entitlement),
  ])

  return json(toEntitlementsResponse(entitlement, { save, prompt }))
})
