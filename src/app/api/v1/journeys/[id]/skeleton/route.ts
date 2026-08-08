import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { generateSkeleton } from '@/server/modules/journey/service'
import { assembleJourneyView } from '@/server/modules/journey/view'

/**
 * POST /api/v1/journeys/{id}/skeleton — draft the whole trip.
 *
 * DRAFT-FIRST IS THE DEFAULT, because a blank canvas suits a power planner and
 * freezes everybody else. Every item it writes is a placeholder describing a
 * KIND of thing, never a named business — real options arrive when the traveller
 * opens a pillar.
 *
 * Refuses on a plan that already has items: a second skeleton would silently
 * discard whatever they had arranged, and regenerating one day exists for
 * somebody who wants a fresh start on part of it.
 */

const SKELETONS_PER_USER_PER_HOUR = 20

export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]/skeleton'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    await enforceRateLimit(
      {
        key: `journey-skeleton:user:${claims.userId}`,
        limit: SKELETONS_PER_USER_PER_HOUR,
        windowSeconds: 60 * 60,
      },
      'That is a lot of drafts at once. Give it a minute.'
    )

    return json(assembleJourneyView(await generateSkeleton(id, claims.userId)))
  }
)
