import type { NextRequest } from 'next/server'
import { clientContext, optionalUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { parseJson } from '@/server/http/validate'
import { parseIntake } from '@/server/modules/journey/ai'
import { ParseIntakeBody } from '@/server/modules/journey/schema'

/**
 * POST /api/v1/journeys/parse — understand a typed sentence.
 *
 * THE ONLY MODEL CALL AN ANONYMOUS VISITOR CAN MAKE, and that is the point of
 * the whole funnel: somebody types their trip, watches it be understood, and
 * only then meets the sign-in wall. Gating this would put the wall in front of
 * the thing that earns the account.
 *
 * NOTHING IS PERSISTED. The parse is returned and forgotten — a journey is
 * created by the next call, which does require an account. So an
 * unauthenticated caller can spend a model call but cannot leave anything
 * behind, which keeps the abuse ceiling at "costs us tokens" rather than "fills
 * our database".
 *
 * That ceiling is what the rate limit is for, and it is keyed on the IP because
 * an anonymous visitor by definition has no session to key on. `clientContext`
 * resolves that address through TRUSTED_PROXY_HOPS; without it the key would be
 * a header the caller writes, which is no key at all.
 */

/** Generous for a person, tight for a script. Nobody retypes a trip forty times. */
const PARSES_PER_IP_PER_HOUR = 40

export const POST = route(async (req: NextRequest) => {
  const { ip } = clientContext(req)

  // Before the body is read, before the model is reachable. This is the one
  // check whose key the caller cannot change by changing what they send.
  await enforceRateLimit(
    {
      key: `journey-parse:ip:${ip ?? 'unknown'}`,
      limit: PARSES_PER_IP_PER_HOUR,
      windowSeconds: 60 * 60,
    },
    'That is a lot of trips at once. Give it a minute and try again.'
  )

  // Optional rather than required: a signed-in traveller starting a second trip
  // takes this same path, and attributing their spend is better than booking it
  // as anonymous.
  const claims = await optionalUser(req)

  const body = await parseJson(req, ParseIntakeBody)

  const parsed = await parseIntake(body.text, claims === null ? {} : { userId: claims.userId })

  return json(parsed)
})
