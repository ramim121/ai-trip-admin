import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { UpdateBasicsBody } from '@/server/modules/journey/schema'
import { readJourney, updateBasics } from '@/server/modules/journey/service'
import { assembleJourneyView } from '@/server/modules/journey/view'

/**
 * One plan.
 *
 *   GET   — read it.
 *   PATCH — correct a fact about the trip.
 *
 * Ownership is a WHERE clause inside the service, so somebody else's plan is a
 * 404 here rather than a 403 — "not yours" and "does not exist" must look
 * identical from outside, or the endpoint becomes a way to enumerate real ids.
 *
 * PATCH IS FOR THE EDITABLE CHIPS above the workspace. A traveller corrects a
 * parsing mistake by tapping, not by chatting, which is why every field the
 * parser fills is settable here.
 */

export const GET = route(async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]'>) => {
  const claims = await requireUser(req)
  const { id } = await ctx.params

  return json(assembleJourneyView(await readJourney(id, claims.userId)))
})

export const PATCH = route(async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]'>) => {
  const claims = await requireUser(req)
  const { id } = await ctx.params

  const body = await parseJson(req, UpdateBasicsBody)

  return json(assembleJourneyView(await updateBasics(id, claims.userId, body)))
})
