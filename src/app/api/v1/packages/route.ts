import type { NextRequest } from 'next/server'
import { json, route } from '@/server/http/handler'
import { parseQuery } from '@/server/http/validate'
import { PackageListQuery, toPublicPackageSummary } from '@/server/modules/packages/schema'
import { listPackages } from '@/server/modules/packages/service'

/**
 * GET /api/v1/packages — the Discover catalogue.
 *
 * Public and unauthenticated. Only PUBLISHED rows are ever returned, and that
 * is a WHERE clause in the service rather than a filter here — a client handed
 * drafts would have to remember to drop them, and one day one of them would not.
 *
 * `scope` is optional and the website deliberately omits it. Both tabs arrive in
 * one response and the split happens client-side, so switching between Domestic
 * and International costs no request and shows no spinner. A mobile client on a
 * slow connection can ask for one scope instead.
 *
 * Every card carries `registeredCount` and `nextDeparture` already joined. Those
 * are the two figures the card exists to show — how many people are in, and
 * when it goes — and making each client fetch them per package would turn one
 * query into sixty.
 */
export const GET = route(async (req: NextRequest) => {
  const query = parseQuery(new URL(req.url), PackageListQuery)

  const packages = await listPackages({ scope: query.scope, query: query.q })

  return json({ packages: packages.map(toPublicPackageSummary) })
})
