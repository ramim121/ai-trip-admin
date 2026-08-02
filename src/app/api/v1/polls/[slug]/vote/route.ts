import { cookies } from 'next/headers'
import type { NextRequest } from 'next/server'
import { env } from '@/lib/env'
import { hashIp } from '@/server/auth/crypto'
import { badRequest } from '@/server/http/errors'
import { clientContext, optionalUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { enforceRateLimit, type RateLimitRule } from '@/server/http/rate-limit'
import { parseJson } from '@/server/http/validate'
import {
  VISITOR_COOKIE_MAX_AGE_SECONDS,
  VISITOR_COOKIE_NAME,
  identifyVisitor,
  readVisitorCookie,
  signVisitorCookie,
} from '@/server/modules/entitlements/anonymous'
import { CastVoteBody, toPublicPoll } from '@/server/modules/polls/schema'
import { castVote, isOpen, userVoterKey, visitorVoterKey } from '@/server/modules/polls/service'

/**
 * POST /api/v1/polls/{slug}/vote — one vote, once.
 *
 * The guarantee is a UNIQUE index on (pollId, voterKey), and everything here
 * exists to give that index something meaningful to be unique on.
 *
 * A signed-in caller is their account. Everyone else is a visitor, resolved
 * through the same union of weak signals the planner preview uses — cookie, or
 * address, or device fingerprint, and a hit on any one of them is the same
 * person. None of the three is strong alone; together they cost enough effort
 * to defeat that a poll about where to run a trip next is not worth it.
 *
 * A caller we cannot identify at all is refused rather than waved through. That
 * state means every signal was absent — no cookie, no resolvable address, no
 * fingerprint — and a voter with no identity is a voter who can vote any number
 * of times. Refusing is the only answer that keeps the numbers meaning anything.
 *
 * A second vote is NOT an error. It comes back `counted: false` with the
 * results, which is what a returning visitor actually wanted; a 409 would make
 * the ordinary act of revisiting a page look like a failure.
 */

/** Votes per hour from one resolved address, across every poll. */
export const VOTE_REQUESTS_PER_IP_PER_HOUR = 30

/** Votes per hour from every unidentifiable caller, together. */
export const VOTE_REQUESTS_UNRESOLVED_PER_HOUR = 90

const VOTE_WINDOW_SECONDS = 60 * 60

/**
 * The backstop behind the unique index.
 *
 * The index stops one voter voting twice; it does nothing about somebody
 * minting a fresh visitor per request, which is cheap because a fingerprint is
 * a plain body field. This counts addresses instead, so new rows do not mint
 * new allowances — the same argument as `teaserIpRule`, and the same shared
 * pool for callers whose address does not resolve.
 */
function voteIpRule(ip: string | null): RateLimitRule {
  const digest = hashIp(ip)

  return digest === null
    ? {
        key: 'poll-vote:ip:unresolved',
        limit: VOTE_REQUESTS_UNRESOLVED_PER_HOUR,
        windowSeconds: VOTE_WINDOW_SECONDS,
      }
    : {
        key: `poll-vote:ip:${digest}`,
        limit: VOTE_REQUESTS_PER_IP_PER_HOUR,
        windowSeconds: VOTE_WINDOW_SECONDS,
      }
}

export const POST = route(
  async (req: NextRequest, ctx: RouteContext<'/api/v1/polls/[slug]/vote'>) => {
    const { slug } = await ctx.params

    const { ip } = clientContext(req)
    await enforceRateLimit(
      voteIpRule(ip),
      'Too many votes from your network. Please try again a little later.'
    )

    const body = await parseJson(req, CastVoteBody)
    const claims = await optionalUser(req)

    let voterKey: string
    let anonymousVisitorId: string | null = null

    if (claims !== null) {
      voterKey = userVoterKey(claims.userId)
    } else {
      const visitor = await identifyVisitor({
        cookieId: readVisitorCookie(req.cookies.get(VISITOR_COOKIE_NAME)?.value),
        ip,
        fingerprint: body.deviceFingerprint,
      })

      if (visitor === null) {
        // Every signal was absent. 400 rather than 401: signing in is one fix,
        // but so is allowing cookies, and telling them to log in would be wrong
        // about which of the two we actually need.
        throw badRequest(
          'We could not identify this browser well enough to count a vote. Enable cookies, or ' +
            'sign in, and try again.'
        )
      }

      anonymousVisitorId = visitor.id
      voterKey = visitorVoterKey(visitor.id)

      // Re-issued every time, deliberately. Somebody recognised by address or
      // fingerprint after clearing cookies is pulled back onto their canonical
      // id rather than re-derived from the weaker signals on every visit.
      const jar = await cookies()
      jar.set(VISITOR_COOKIE_NAME, signVisitorCookie(visitor.cookieId), {
        httpOnly: true,
        // Lax, not Strict: somebody arrives at Discover from a search result
        // and must still be recognised on that first cross-site navigation.
        sameSite: 'lax',
        secure: env().NODE_ENV === 'production',
        path: '/',
        maxAge: VISITOR_COOKIE_MAX_AGE_SECONDS,
      })
    }

    const now = new Date()
    const result = await castVote(
      {
        slug,
        optionId: body.optionId,
        voterKey,
        userId: claims?.userId ?? null,
        anonymousVisitorId,
      },
      now
    )

    return json({
      counted: result.counted,
      poll: toPublicPoll(result.poll, {
        // Their choice is known either way now, so the results are theirs to
        // see — including on the "you already voted" path, which is the whole
        // reason that path returns a poll rather than an error.
        votedOptionId: result.chosenOptionId,
        open: isOpen(result.poll, now),
      }),
    })
  }
)
