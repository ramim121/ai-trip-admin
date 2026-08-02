import { notFound } from '@/server/http/errors'
import { json, route } from '@/server/http/handler'
import { toPublicPackage } from '@/server/modules/packages/schema'
import { getPackage } from '@/server/modules/packages/service'

/**
 * GET /api/v1/packages/{slug} — one trip, in full.
 *
 * The day-by-day IS the product description for a package, so it ships with the
 * detail response rather than behind a second call. Same for the leaders: "who
 * is running this" is a reason people book a group trip, not a detail they go
 * looking for afterwards.
 *
 * A DRAFT slug 404s exactly as an unknown slug does. That is deliberate rather
 * than incidental — a trip ops has not published is not a secret, but it is not
 * an announcement either, and "coming soon, here is the URL" should be a
 * decision somebody makes rather than an accident of a WHERE clause.
 */
export const GET = route(async (_req, ctx: RouteContext<'/api/v1/packages/[slug]'>) => {
  const { slug } = await ctx.params

  const pkg = await getPackage(slug)
  if (pkg === null) throw notFound('No such trip.')

  return json({ package: toPublicPackage(pkg) })
})
