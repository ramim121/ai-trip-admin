import type { NextRequest } from 'next/server'
import { badRequest } from '@/server/http/errors'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { estimateGap, readJourney } from '@/server/modules/journey/service'

/**
 * GET /api/v1/journeys/{id}/transfers — how to get from A to B.
 *
 * Answers a gap-card. The curated route table is consulted first and its rows
 * are treated as facts: where the agency has actually sold a route it knows the
 * price, and that comes back marked high confidence. Where it has not, the model
 * estimates and says so — the interface shows the difference, so the badge means
 * something rather than decorating every card equally.
 */

const TRANSFER_ESTIMATES_PER_USER_PER_HOUR = 60

export const GET = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]/transfers'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    const url = new URL(req.url)
    const from = url.searchParams.get('from')?.trim() ?? ''
    const to = url.searchParams.get('to')?.trim() ?? ''

    if (from === '' || to === '') throw badRequest('Which two places?')
    if (from.toLowerCase() === to.toLowerCase()) {
      throw badRequest('Those are the same place.')
    }

    await enforceRateLimit(
      {
        key: `journey-transfer:user:${claims.userId}`,
        limit: TRANSFER_ESTIMATES_PER_USER_PER_HOUR,
        windowSeconds: 60 * 60,
      },
      'That is a lot of routes at once. Give it a moment.'
    )

    const journey = await readJourney(id, claims.userId)
    const partySize = journey.partyAdults + journey.partyChildren

    const estimate = await estimateGap(
      { afterItemId: '', dayNumber: 1, from, to },
      partySize,
      claims.userId
    )

    return json(estimate)
  }
)
