import type { NextRequest } from 'next/server'
import { badRequest } from '@/server/http/errors'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { addBlock } from '@/server/modules/planner/itinerary'
import { CreateBlockBody } from '@/server/modules/planner/schema'

/**
 * POST /api/v1/itineraries/{id}/days/{day}/blocks — put something on the timeline.
 *
 * `day` is the 1-based day number rather than a day id: it is what the traveller
 * sees on screen and what a drag-and-drop client already has to hand.
 *
 * A block that clashes with another is still accepted. The traveller is allowed
 * to build a day we believe is impossible — they may know something about the
 * road that we do not — and our job is to say so, not to refuse. The whole
 * itinerary comes back with `conflicts` populated, which makes the clash
 * unmissable without making it an error.
 *
 * What IS refused: an ACTIVITY block with no `activityId`, an `activityId` on
 * any other kind, and an activity that is not in the catalog or is no longer
 * offered. That is the catalog rule at its last enforcement point.
 */
export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/itineraries/[id]/days/[day]/blocks'>) => {
    const claims = await requireUser(req)
    const { id, day } = await ctx.params
    const body = await parseJson(req, CreateBlockBody)

    const dayNumber = Number(day)
    if (!Number.isInteger(dayNumber) || dayNumber < 1) {
      throw badRequest('The day must be a whole number, counting from 1.', [
        { path: 'day', message: 'Not a day number.' },
      ])
    }

    return json(await addBlock(claims.userId, id, dayNumber, body), 201)
  }
)
