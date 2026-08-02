import type { NextRequest } from 'next/server'
import { hashIp } from '@/server/auth/crypto'
import { clientContext, optionalUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { enforceRateLimit, type RateLimitRule } from '@/server/http/rate-limit'
import { parseJson } from '@/server/http/validate'
import { RegisterInterestBody } from '@/server/modules/packages/schema'
import { registerInterest } from '@/server/modules/packages/service'

/**
 * POST /api/v1/packages/{slug}/interest — "I would come on this."
 *
 * The join list for a trip we have not costed yet, and the enquiry list for one
 * we have. Open to signed-out visitors on purpose: requiring an account before
 * somebody may say they are interested loses exactly the people the list is for.
 *
 * WHAT PROTECTS IT
 *
 * The unique index on (packageId, email) is the real defence, and it is a
 * correctness guarantee before it is an anti-abuse one: registering twice is a
 * double-click or a correction, not two travellers, and this count is printed
 * on a public card. Without it a refresh would inflate the number the feature
 * exists to communicate.
 *
 * The rate limit is the abuse half. One address can register under any number
 * of email addresses, and each one is a row and an inflated count, so the
 * request rate is capped per resolved edge address exactly as the planner
 * preview is. Unresolved callers share one pool, for the reason set out in
 * `teaserIpRule`: when `TRUSTED_PROXY_HOPS` is 0 there is no way to tell two
 * anonymous callers apart, and a private allowance each would be a private
 * allowance per request.
 *
 * A signed-in caller's account is attached to the row, which is what lets ops
 * see that a lead is already a customer. It does NOT replace the address they
 * typed — somebody registering a friend's email from their own account is doing
 * something perfectly reasonable.
 */

/** Registrations per hour from one resolved address. */
export const INTEREST_REQUESTS_PER_IP_PER_HOUR = 20

/** Registrations per hour from every unidentifiable caller, together. */
export const INTEREST_REQUESTS_UNRESOLVED_PER_HOUR = 60

const INTEREST_WINDOW_SECONDS = 60 * 60

function interestIpRule(ip: string | null): RateLimitRule {
  const digest = hashIp(ip)

  return digest === null
    ? {
        key: 'interest:ip:unresolved',
        limit: INTEREST_REQUESTS_UNRESOLVED_PER_HOUR,
        windowSeconds: INTEREST_WINDOW_SECONDS,
      }
    : {
        key: `interest:ip:${digest}`,
        limit: INTEREST_REQUESTS_PER_IP_PER_HOUR,
        windowSeconds: INTEREST_WINDOW_SECONDS,
      }
}

export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/packages/[slug]/interest'>) => {
    const { slug } = await ctx.params

    const { ip } = clientContext(req)
    await enforceRateLimit(
      interestIpRule(ip),
      'Too many registrations from your network. Please try again a little later.'
    )

    const body = await parseJson(req, RegisterInterestBody)
    const claims = await optionalUser(req)

    const result = await registerInterest({
      slug,
      name: body.name,
      email: body.email,
      phone: body.phone ?? null,
      partySize: body.partySize,
      message: body.message ?? null,
      departureId: body.departureId ?? null,
      userId: claims?.userId ?? null,
    })

    // 200 rather than 201, even when a row was created. The resource a caller
    // could then GET is the package, not the registration — there is no
    // /interests/{id} to point a Location header at, and inventing one would
    // publish a URL that reveals who registered for what.
    return json(result)
  }
)
