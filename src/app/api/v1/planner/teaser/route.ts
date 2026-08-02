import { cookies } from 'next/headers'
import type { NextRequest } from 'next/server'
import { AiCallOutcome, AiSurface } from '@/generated/prisma/enums'
import { env } from '@/lib/env'
import { resolveModelSelection, schemaConstrainedModel } from '@/server/ai/provider'
import type { TeaserQuestionnaire } from '@/server/ai/schemas'
import { recordAiUsage } from '@/server/ai/usage-log'
import { clientContext, optionalUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { consumeRateLimit, enforceRateLimit } from '@/server/http/rate-limit'
import { parseJson } from '@/server/http/validate'
import {
  VISITOR_COOKIE_MAX_AGE_SECONDS,
  VISITOR_COOKIE_NAME,
  anonymousPromptLimit,
  consumePrompt,
  identifyVisitor,
  readVisitorCookie,
  refundPrompt,
  signVisitorCookie,
} from '@/server/modules/entitlements/anonymous'
import { TeaserRequest, type TeaserReply } from '@/server/modules/entitlements/schema'
import {
  anonymousActor,
  canPrompt,
  entitlementRefused,
  recordUsage,
  userActor,
  type Actor,
} from '@/server/modules/entitlements/service'
import { readTeaserCache, writeTeaserCache } from '@/server/modules/entitlements/teaser-cache'
import {
  TEASER_DAILY_GENERATION_RULE,
  generateTeaser,
  teaserCeilingReached,
  teaserDisabled,
  teaserEnabled,
  teaserIpRule,
  teaserTooManyRequests,
} from '@/server/modules/entitlements/teaser'
import { tooManyRequests } from '@/server/http/errors'

/**
 * POST /api/v1/planner/teaser — the one reply an anonymous visitor ever gets.
 *
 * The order of operations here is the product rule, and it is not the obvious
 * order:
 *
 *   0. Rate-limit on the resolved edge address, before anything else.
 *   1. Identify the visitor, by cookie OR IP hash OR fingerprint hash.
 *   2. Claim the prompt, atomically, before anything expensive happens.
 *   3. Only then look in the cache, and only then spend from the day's ceiling
 *      and call the model.
 *
 * Claiming first is what makes the per-visitor limit real. Check the quota,
 * generate, then decrement, and two tabs opened together both pass the check
 * and both get a reply. The atomic claim inside `consumePrompt` is the only
 * thing standing between "one preview" and "one preview per concurrent
 * request".
 *
 * The cache is consulted *after* the claim, never before. A cached reply still
 * spends the prompt: the rule is one reply, not one model call. What the cache
 * buys is that the abuse case — the same trip retyped from a fresh incognito
 * window — costs no AI spend at all, which is why the questionnaire is four
 * fixed fields rather than a chat box.
 *
 * A signed-in caller skips the visitor machinery entirely. They are metered
 * against their plan, and burning an anonymous quota for somebody who already
 * has an account would be both wrong and rude.
 *
 * WHY THERE ARE TWO RATE LIMITS ON TOP OF ALL THAT
 *
 * Steps 1 and 2 meter a VISITOR, and the visitor is chosen by signals the
 * caller sends: a cookie they may omit, a fingerprint that is a plain body
 * field, an address that is only as trustworthy as `TRUSTED_PROXY_HOPS` says.
 * Every one of those can be varied per request, and a caller who varies them
 * gets a fresh row with a fresh allowance every time. So step 0 counts
 * addresses instead of visitors — no amount of new rows produces a new address
 * — and step 3 counts model calls site-wide, so even a flaw nobody has found
 * yet cannot cost more than one day's ceiling before somebody notices. Neither
 * limit trusts anything the other one trusts, which is the point of having two.
 *
 * Both apply to signed-in callers too. A traveller account is as cheap to mint
 * as a visitor row, and FREE has no per-period prompt cap, so exempting them
 * would leave the same hole one signup further away.
 */

/** Narrow the body to exactly the four fields the cache is keyed on. */
function questionnaire(body: TeaserRequest): TeaserQuestionnaire {
  return {
    destination: body.destination,
    totalDays: body.totalDays,
    partySize: body.partySize,
    purpose: body.purpose,
  }
}

export const POST = route(async (req: NextRequest) => {
  const body = await parseJson(req, TeaserRequest)
  const answers = questionnaire(body)

  const { ip } = clientContext(req)

  // Before the body is acted on, before a row is read or written, and long
  // before the model is reachable. This is the one check whose key the caller
  // cannot change by changing what they send.
  await enforceRateLimit(teaserIpRule(ip), teaserTooManyRequests())

  const claims = await optionalUser(req)

  let actor: Actor
  let visitorId: string | null = null
  let promptsRemaining: number | null = null

  if (claims !== null) {
    actor = userActor(claims.userId)
  } else {
    const visitor = await identifyVisitor({
      cookieId: readVisitorCookie(req.cookies.get(VISITOR_COOKIE_NAME)?.value),
      ip,
      fingerprint: body.deviceFingerprint,
    })

    // Null means no signal identified anybody: no cookie, no resolved address,
    // and a fingerprint that hashed to nothing. `identifyVisitor` used to
    // answer that by creating a row with `promptsUsed: 0`, which handed out a
    // free preview to every request that simply declined to say who it was.
    // A null visitor id is precisely the state `canPrompt` refuses outright, so
    // carry it through and let the refusal below do the talking — it is the
    // same 403 and the same sign-in offer an exhausted visitor gets, which is
    // deliberate: an attacker must not be able to tell "we do not know you"
    // apart from "you have had yours".
    visitorId = visitor?.id ?? null
    actor = anonymousActor(visitorId)

    if (visitor !== null) {
      // Always re-issued, deliberately. When someone was recognised by IP or
      // fingerprint after clearing their cookies, this hands back the canonical
      // id — pulling the browser onto the identity it tried to shed, instead of
      // leaving it to be re-derived from the weaker signals on every request.
      const jar = await cookies()
      jar.set(VISITOR_COOKIE_NAME, signVisitorCookie(visitor.cookieId), {
        httpOnly: true,
        // Lax, not Strict: a visitor arrives from an ad or a search result, and
        // must still be recognised on that first cross-site navigation.
        sameSite: 'lax',
        secure: env().NODE_ENV === 'production',
        path: '/',
        maxAge: VISITOR_COOKIE_MAX_AGE_SECONDS,
      })
    }
  }

  // Advisory: this produces the message and the offer. The binding check is the
  // atomic claim below.
  const decision = await canPrompt(actor)
  if (!decision.allowed) throw entitlementRefused(decision.refusal)

  if (visitorId !== null) {
    const limit = await anonymousPromptLimit()
    const claimed = await consumePrompt(visitorId, limit)

    // Lost the race, or the limit is zero. Either way the answer is the refusal
    // `canPrompt` gives — a visitor must not be able to tell a lost race from
    // an exhausted quota, because for them the two mean the same thing.
    if (!claimed) {
      const recheck = await canPrompt(actor)
      throw entitlementRefused(
        recheck.allowed
          ? {
              reason: 'ANON_PROMPT_EXHAUSTED',
              message: 'You have used your free preview. Log in to continue planning.',
              upgrade: null,
            }
          : recheck.refusal
      )
    }

    promptsRemaining = decision.remaining === null ? null : Math.max(0, decision.remaining - 1)
  } else if (claims !== null) {
    await recordUsage(claims.userId, { aiPromptsUsed: 1 })
  }

  // Who the spend belongs to, resolved once. At most one of these is ever set:
  // a signed-in caller never touches the visitor machinery above.
  const attribution = { userId: claims?.userId ?? null, anonymousVisitorId: visitorId }

  try {
    const cached = await readTeaserCache(answers)
    if (cached !== null) {
      // Recorded even though nothing was spent — especially because nothing was
      // spent. "How many previews did the cache serve" is the number that
      // justifies the cache, and it cannot be recovered later from rows that
      // were never written. The selection is resolved for the sake of the
      // column, not to call anything: it records which model WOULD have run.
      recordAiUsage({
        surface: AiSurface.TEASER,
        outcome: AiCallOutcome.SUCCEEDED,
        selection: await resolveModelSelection(schemaConstrainedModel()),
        cached: true,
        ...attribution,
      })

      const reply: TeaserReply = { teaser: cached, cached: true, promptsRemaining }
      return json(reply)
    }

    // Checked here rather than at the top: with the switch off we still serve
    // the cache, because that costs nothing. The switch exists to stop spend,
    // not to take the product away.
    if (!(await teaserEnabled())) {
      recordAiUsage({
        surface: AiSurface.TEASER,
        outcome: AiCallOutcome.REFUSED,
        selection: await resolveModelSelection(schemaConstrainedModel()),
        errorKind: 'TeaserDisabled',
        ...attribution,
      })
      throw teaserDisabled()
    }

    // The day's ceiling, consumed only now — past the cache, so it counts model
    // calls and not replies. Everything above this line is free.
    const ceiling = await consumeRateLimit(TEASER_DAILY_GENERATION_RULE)
    if (!ceiling.allowed) {
      recordAiUsage({
        surface: AiSurface.TEASER,
        outcome: AiCallOutcome.REFUSED,
        selection: await resolveModelSelection(schemaConstrainedModel()),
        errorKind: 'DailyCeilingReached',
        ...attribution,
      })
      // Logged, and logged loudly, because this firing is never routine. Either
      // the site is more popular than the number assumed, or something is
      // generating previews that should have been cached — and the two look
      // identical from a billing dashboard a month later.
      console.error(
        `[rate-limit] teaser daily generation ceiling reached: ${ceiling.hits} attempted ` +
          `against a limit of ${ceiling.limit}; refusing uncached generations for another ` +
          `${ceiling.retryAfterSeconds}s`
      )
      throw tooManyRequests(teaserCeilingReached())
    }

    const teaser = await generateTeaser(answers, attribution)
    await writeTeaserCache(answers, teaser)

    const reply: TeaserReply = { teaser, cached: false, promptsRemaining }
    return json(reply)
  } catch (e) {
    // No reply was produced, so the prompt was not really spent. The refund is
    // safe precisely because it is unreachable on the success path: the only
    // way here is a failure that gave the visitor nothing.
    if (visitorId !== null) await refundPrompt(visitorId)
    throw e
  }
})
