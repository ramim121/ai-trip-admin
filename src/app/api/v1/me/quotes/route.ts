import type { NextRequest } from 'next/server'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { toQuoteView } from '@/server/modules/quotes/schema'
import { listMyQuotes } from '@/server/modules/quotes/service'

/**
 * GET /api/v1/me/quotes — every quote this traveller has asked for.
 *
 * No parameter says whose. The user id comes from the token and goes straight
 * into the query, exactly as on /me/payments and /me/bookings — an endpoint
 * that took an id would be an endpoint somebody eventually passes somebody
 * else's.
 *
 * DRAFT REVISIONS ARE ABSENT. The service filters to sent versions only, so a
 * traveller sees the prices ops has agreed to stand behind and never the ones
 * still being worked out. A quote awaiting pricing therefore arrives with an
 * empty `revisions` array, which is the truthful representation of "we have
 * your request and are working on it".
 */
export const GET = route(async (req: NextRequest) => {
  const claims = await requireUser(req)

  const quotes = await listMyQuotes(claims.userId)

  return json({ quotes: quotes.map(toQuoteView) })
})
