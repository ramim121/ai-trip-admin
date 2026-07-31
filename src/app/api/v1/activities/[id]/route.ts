import type { NextRequest } from 'next/server'
import { notFound } from '@/server/http/errors'
import { json, route } from '@/server/http/handler'
import { toPublicActivity } from '@/server/modules/catalog/schema'
import { getActivity } from '@/server/modules/catalog/service'

/**
 * GET /api/v1/activities/{id} — one activity, in full.
 *
 * Public and unauthenticated. Everything a detail page needs in one response:
 * the long description, every image with its alt text, the interest tags, and
 * the opening hours as minutes from local midnight.
 *
 * The id is not validated as a uuid before the lookup, and that is deliberate. A
 * malformed id would 400 while an unknown one 404s, and the difference between
 * the two is a free oracle for anyone probing what our ids look like. Both
 * answer 404 here, as does an unpublished draft — "we do not have that" is the
 * whole of what a public caller learns.
 *
 * An empty `openingHours` means always available, not closed. The schema says so
 * too, because a client that inverted it would put a "closed" badge on every
 * beach and viewpoint in the catalog.
 */
export const GET = route(
  async (_req: NextRequest, ctx: RouteContext<'/api/v1/activities/[id]'>) => {
    const { id } = await ctx.params

    const activity = await getActivity(id)
    if (activity === null) throw notFound('No such activity.')

    return json(toPublicActivity(activity))
  }
)
