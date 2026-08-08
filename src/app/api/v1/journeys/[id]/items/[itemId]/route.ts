import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { MoveItemBody } from '@/server/modules/journey/schema'
import { moveItem, removeItem } from '@/server/modules/journey/service'
import { assembleJourneyView } from '@/server/modules/journey/view'

/**
 * One item.
 *
 *   PATCH  — move it to another day or day-part.
 *   DELETE — take it off the plan.
 *
 * Both are scoped on the journey as well as the item id, so an id belonging to
 * somebody else's plan changes nothing and answers 404.
 */

export const PATCH = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]/items/[itemId]'>) => {
    const claims = await requireUser(req)
    const { id, itemId } = await ctx.params

    const body = await parseJson(req, MoveItemBody)

    const journey = await moveItem(id, claims.userId, itemId, body.dayNumber, body.slot)

    return json(assembleJourneyView(journey))
  }
)

export const DELETE = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]/items/[itemId]'>) => {
    const claims = await requireUser(req)
    const { id, itemId } = await ctx.params

    return json(assembleJourneyView(await removeItem(id, claims.userId, itemId)))
  }
)
