import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { UpdateItemTimeBody } from '@/server/modules/journey/schema'
import { updateItemTime } from '@/server/modules/journey/service'
import { assembleJourneyView } from '@/server/modules/journey/view'

/**
 * PATCH /api/v1/journeys/{id}/items/{itemId}/time — set an exact time.
 *
 * SEPARATE FROM MOVING, because they are different acts. Moving changes which
 * part of the day something sits in; this pins it to a clock, which is what
 * turns a floating item into one the conflict checker can compare against
 * others. Null clears it and lets the item float again.
 */
export const PATCH = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]/items/[itemId]/time'>) => {
    const claims = await requireUser(req)
    const { id, itemId } = await ctx.params

    const body = await parseJson(req, UpdateItemTimeBody)

    const journey = await updateItemTime(
      id,
      claims.userId,
      itemId,
      body.startMinute,
      body.durationMin
    )

    return json(assembleJourneyView(journey))
  }
)
