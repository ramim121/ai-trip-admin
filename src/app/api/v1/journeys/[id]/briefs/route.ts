import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { parseJson } from '@/server/http/validate'
import { RefineBriefBody } from '@/server/modules/journey/schema'
import { refineBrief } from '@/server/modules/journey/service'

/**
 * POST /api/v1/journeys/{id}/briefs — merge a message into a preference brief.
 *
 * THE FLAGSHIP FEATURE, and the thing the admin actually consumes. Every message
 * about hotels in one place merges into one structured brief instead of
 * scrolling away as prose, and it survives a concrete pick — knowing somebody
 * chose one hotel AND wanted "3-star plus, pool, quiet end of Patong" is what
 * lets ops substitute something better with confidence.
 *
 * The response carries refinement chips, so the next thing a traveller is likely
 * to want is one tap rather than another sentence.
 */

const REFINEMENTS_PER_USER_PER_HOUR = 120

export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]/briefs'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    await enforceRateLimit(
      {
        key: `journey-brief:user:${claims.userId}`,
        limit: REFINEMENTS_PER_USER_PER_HOUR,
        windowSeconds: 60 * 60,
      },
      'Slow down a moment — that is a lot of refining.'
    )

    const body = await parseJson(req, RefineBriefBody)

    const result = await refineBrief(id, claims.userId, body.pillar, body.location, body.message)

    return json({
      brief: {
        id: result.brief.id,
        pillar: result.brief.pillar,
        location: result.brief.location,
        nights: null,
        constraints: result.brief.constraints ?? null,
        summary: result.brief.summary,
      },
      refinementChips: result.refinementChips,
    })
  }
)
