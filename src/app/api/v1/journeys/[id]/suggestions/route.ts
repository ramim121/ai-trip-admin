import type { NextRequest } from 'next/server'
import { BriefPillar } from '@/generated/prisma/enums'
import { badRequest } from '@/server/http/errors'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { readBrief, readJourney } from '@/server/modules/journey/service'
import { suggestFor } from '@/server/modules/journey/suggestions'

/**
 * GET /api/v1/journeys/{id}/suggestions — six real options for one pillar.
 *
 * Reads the traveller's brief for that pillar and place, asks the right provider
 * for candidates, and has the ranker choose six with a reason each. Nothing is
 * invented: candidates come from Viator or Google Places, and the ranker may
 * only choose among them.
 *
 * A missing brief is not an error. Somebody who opens "Things to do" before
 * saying anything should see what exists there, ranked on the trip's own facts —
 * an empty panel would teach them the pillar is broken.
 */

const SUGGESTION_BATCHES_PER_USER_PER_HOUR = 90

export const GET = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/journeys/[id]/suggestions'>) => {
    const claims = await requireUser(req)
    const { id } = await ctx.params

    const url = new URL(req.url)
    const rawPillar = url.searchParams.get('pillar')
    const location = url.searchParams.get('location')?.trim() ?? ''

    if (rawPillar === null || !Object.hasOwn(BriefPillar, rawPillar)) {
      throw badRequest('Which pillar? One of STAY, ACTIVITY, FOOD or TRANSPORT.')
    }
    if (location === '') throw badRequest('Which place are we looking in?')

    const pillar = rawPillar as BriefPillar

    await enforceRateLimit(
      {
        key: `journey-suggest:user:${claims.userId}`,
        limit: SUGGESTION_BATCHES_PER_USER_PER_HOUR,
        windowSeconds: 60 * 60,
      },
      'That is a lot of searching. Give it a moment.'
    )

    // Ownership check first, so a stranger cannot spend our provider quota
    // against somebody else's plan id.
    const journey = await readJourney(id, claims.userId)
    const brief = await readBrief(id, pillar, location)

    // With no brief yet, the trip's own facts are the brief — enough for a
    // useful first batch, and it improves the moment they say anything.
    const summary =
      brief?.summary ??
      [journey.tripType, journey.partyType, ...journey.interests].filter(Boolean).join(', ')

    const batch = await suggestFor(
      pillar,
      location,
      summary,
      brief?.constraints ?? {},
      claims.userId
    )

    return json(batch)
  }
)
