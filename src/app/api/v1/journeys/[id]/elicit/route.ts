import type { NextRequest } from 'next/server'
import { badRequest } from '@/server/http/errors'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { readJourney } from '@/server/modules/journey/service'
import { elicitFor } from '@/server/modules/journey/suggestions'

/**
 * GET /api/v1/journeys/{id}/elicit — which format of a packaged tour?
 *
 * Fires when a traveller picks a CATEGORY matching many real products — "island
 * hopping" in Krabi is 774 of them. The elicitor reads the actual inventory and
 * asks about a dimension that genuinely varies across it.
 *
 * A null question is a real answer, not a failure: when the products do not
 * meaningfully differ, asking anyway would be a question with one true answer,
 * which teaches a traveller that the questions here are decoration.
 */

const ELICITATIONS_PER_USER_PER_HOUR = 60

export const GET = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]/elicit'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    const url = new URL(req.url)
    const category = url.searchParams.get('category')?.trim() ?? ''
    const location = url.searchParams.get('location')?.trim() ?? ''

    if (category === '') throw badRequest('Which kind of thing?')
    if (location === '') throw badRequest('Which place are we looking in?')

    await enforceRateLimit(
      {
        key: `journey-elicit:user:${claims.userId}`,
        limit: ELICITATIONS_PER_USER_PER_HOUR,
        windowSeconds: 60 * 60,
      },
      'That is a lot of questions at once. Give it a moment.'
    )

    await readJourney(id, claims.userId)

    return json(await elicitFor(category, location, claims.userId))
  }
)
