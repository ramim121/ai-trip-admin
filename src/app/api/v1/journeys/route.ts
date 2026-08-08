import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { parseJson } from '@/server/http/validate'
import { parseIntake } from '@/server/modules/journey/ai'
import { CreateJourneyBody } from '@/server/modules/journey/schema'
import { createJourney, listJourneys, readJourney } from '@/server/modules/journey/service'
import { assembleJourneyView } from '@/server/modules/journey/view'

/**
 * The journey collection.
 *
 *   GET  — every plan this traveller has.
 *   POST — turn a typed sentence into a real plan.
 *
 * THE PARSE IS RUN AGAIN HERE RATHER THAN ACCEPTED FROM THE CLIENT, even though
 * /parse just did it. A parse posted by a browser is a trip description the
 * caller wrote, and trusting it would let somebody set a sixty-day trip with a
 * ten-lakh budget by editing a JSON body. The second call costs a fraction of a
 * cent and removes the question entirely.
 */

const JOURNEYS_PER_USER_PER_HOUR = 12

export const GET = route(async (req: NextRequest) => {
  const claims = await requireUser(req)

  const journeys = await listJourneys(claims.userId)

  return json({
    journeys: journeys.map((journey) => ({
      id: journey.id,
      title: journey.title,
      destinations: journey.destinations,
      durationDays: journey.durationDays,
      status: journey.status,
      // A `@db.Date` as the calendar date it is. Postgres hands these back at
      // UTC midnight, so slicing is correct where a local formatter would render
      // the previous day for every zone west of UTC.
      startDate: journey.startDate === null ? null : journey.startDate.toISOString().slice(0, 10),
      itemCount: journey._count.items,
      updatedAt: journey.updatedAt.toISOString(),
    })),
  })
})

export const POST = route(async (req: NextRequest) => {
  const claims = await requireUser(req)

  await enforceRateLimit(
    {
      key: `journey-create:user:${claims.userId}`,
      limit: JOURNEYS_PER_USER_PER_HOUR,
      windowSeconds: 60 * 60,
    },
    'That is a lot of new plans at once. Give it a minute and try again.'
  )

  const body = await parseJson(req, CreateJourneyBody)

  const parsed = await parseIntake(body.text, { userId: claims.userId })
  const journeyId = await createJourney(parsed, body.text, claims.userId)

  return json(assembleJourneyView(await readJourney(journeyId, claims.userId)), 201)
})
