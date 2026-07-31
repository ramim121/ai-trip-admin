import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { moveBlock, removeBlock } from '@/server/modules/planner/itinerary'
import { UpdateBlockBody } from '@/server/modules/planner/schema'

/**
 * PATCH /api/v1/itineraries/{id}/blocks/{blockId} — move, retime or pin a block.
 *
 * DELETE /api/v1/itineraries/{id}/blocks/{blockId} — take it off the timeline.
 *
 * `dayNumber` in the patch body moves the block to another day of the same trip;
 * omitting it leaves it where it is. Both the day it left and the day it arrived
 * on have their estimated transfers redrawn, because the first one now has a gap
 * where a transfer no longer makes any sense.
 *
 * Nothing else on the timeline moves. If the new position clashes, the clash is
 * reported in `conflicts` and the block stays exactly where the traveller put
 * it — shuffling their afternoon to make our arithmetic work would produce a day
 * nobody asked for.
 *
 * Editing a block we generated makes it theirs: `isEstimate` is cleared, so a
 * later resync can never delete their change.
 *
 * DELETE answers with the updated itinerary rather than 204. Removing a block
 * changes the transfers around it, and a client given no body would have to
 * refetch immediately to draw the timeline correctly.
 */
export const PATCH = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/itineraries/[id]/blocks/[blockId]'>) => {
    const claims = await requireUser(req)
    const { id, blockId } = await ctx.params
    const body = await parseJson(req, UpdateBlockBody)

    return json(await moveBlock(claims.userId, id, blockId, body))
  }
)

export const DELETE = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/itineraries/[id]/blocks/[blockId]'>) => {
    const claims = await requireUser(req)
    const { id, blockId } = await ctx.params

    return json(await removeBlock(claims.userId, id, blockId))
  }
)
