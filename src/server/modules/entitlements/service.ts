import { z } from 'zod'
import { Prisma } from '@/generated/prisma/client'
import {
  BillingInterval,
  ItineraryStatus,
  PlanCode,
  SubscriptionStatus,
} from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import type { EntitlementContext } from '@/server/ai/prompts'
import { MAX_TRIP_DAYS } from '@/server/ai/schemas'
import { ApiError, conflict, notFound } from '@/server/http/errors'
import { readCachedSetting } from '@/server/settings/read'
import { anonymousPromptLimit } from './anonymous'

/**
 * The single answer to "may this actor do this?".
 *
 * Every limit in the product is decided here and nowhere else, and every one of
 * them is decided from the database — never from anything the caller sent. A
 * request may claim it is on PREMIUM_100, that its itinerary is unlocked, or
 * that it only wants two days. None of those claims are read. The plan comes
 * from the Subscription row, the unlock comes from the ItineraryUnlock row, and
 * the day count comes from this module. Assume the client is hostile, because
 * the one that is will look exactly like the ones that are not.
 *
 * A refusal is never a bare `false`. It carries a reason code and the thing
 * that would lift it, because two consumers need to *explain* the wall rather
 * than merely hit it: the web app, which has to render an offer, and the trip
 * designer itself, which has to tell a traveller why the plan stops on day two
 * without inventing a reason.
 *
 * The null trap is why this is a module rather than a few inline comparisons. A
 * null limit on a Plan means UNLIMITED. `saved >= plan.maxSavedItineraries`
 * with a null limit is `saved >= 0`, which is true — turning the most expensive
 * tier into the most restrictive one. Every comparison below tests `=== null`
 * first.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Actors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whoever is asking.
 *
 * Deliberately not "the request": an actor is a resolved identity, produced by
 * a guard that has already verified a token or identified a visitor. Nothing in
 * this module parses a header, so nothing in it can be fooled by one.
 */
export type Actor =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'anonymous'; readonly visitorId: string | null }

export function userActor(userId: string): Actor {
  return { kind: 'user', userId }
}

export function anonymousActor(visitorId: string | null): Actor {
  return { kind: 'anonymous', visitorId }
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why something was refused, in a form a client can branch on.
 *
 * A closed vocabulary on purpose. Clients choose between "sign in", "unlock
 * this one" and "wait for the reset" from these codes, and parsing English to
 * make that choice is how a copy edit breaks a checkout. The message is for a
 * human and its wording is not part of the contract; the code is.
 */
export const REFUSAL_REASONS = [
  'ANON_PROMPT_EXHAUSTED',
  'FREE_DAY_LIMIT',
  'SAVE_LIMIT',
  'PERIOD_LIMIT',
] as const
export type RefusalReason = (typeof REFUSAL_REASONS)[number]

/** What the actor would have to do. `SIGN_IN` costs nothing and is still an upgrade. */
export type UpgradeAction = 'SIGN_IN' | 'UNLOCK_ITINERARY' | 'SUBSCRIBE'

export interface UpgradeOffer {
  action: UpgradeAction
  /** The plan behind the offer, so a checkout never has to guess. */
  planCode: PlanCode | null
  /**
   * Whole taka. Zero for SIGN_IN. Null for SUBSCRIBE, where the price depends
   * on which tier they pick — GET /api/v1/plans is the one place prices live,
   * and a second copy here is the copy that goes stale after a repricing.
   */
  priceBdt: number | null
  /** Short human phrase for a button. Not the full marketing copy. */
  label: string
  /** Set for UNLOCK_ITINERARY: the itinerary the one-off payment would unlock. */
  itineraryId?: string
}

export interface Refusal {
  reason: RefusalReason
  /** Plain-English explanation, safe to show a traveller. */
  message: string
  /** What would lift this wall. Null only when nothing we sell would. */
  upgrade: UpgradeOffer | null
}

/**
 * A refusal that came from the traveller's plan rather than from their request.
 *
 * Extends ApiError so handlers keep throwing one kind of thing, and carries the
 * reason twice: as a field, for logs and for `instanceof` handling, and inside
 * `details`, for the wire.
 *
 * `details` is the only machine-readable slot the error envelope has, and the
 * envelope is a fixed cross-repo contract — `beyond-borders-web/src/lib/api/
 * errors.ts` mirrors it field for field. Growing a new top-level key for one
 * family of endpoints would break that mirror, so `path: 'reason'` names a
 * pseudo-field, which is the same thing a form does with a real one. The offer
 * is not repeated here; the client already has it from GET
 * /api/v1/me/entitlements.
 *
 * 403, not 402 or 429: the caller is not being rate-limited (waiting changes
 * nothing) and 402 has no agreed meaning across clients. They are being told
 * this action needs something they do not have.
 */
export class EntitlementError extends ApiError {
  readonly reason: RefusalReason
  readonly upgrade: UpgradeOffer | null

  constructor(refusal: Refusal) {
    super(403, 'FORBIDDEN', refusal.message, [{ path: 'reason', message: refusal.reason }])
    this.name = 'EntitlementError'
    this.reason = refusal.reason
    this.upgrade = refusal.upgrade
  }
}

/** Throwing form of a refusal, for routes with nothing partial to hand back. */
export function entitlementRefused(refusal: Refusal): EntitlementError {
  return new EntitlementError(refusal)
}

/**
 * A yes, or a structured no.
 *
 * Discriminated on `allowed`, so a caller cannot read `refusal` without having
 * checked, and cannot forget that `remaining` means nothing on the no branch.
 */
export type Decision =
  | { readonly allowed: true; readonly remaining: number | null }
  | { readonly allowed: false; readonly remaining: 0; readonly refusal: Refusal }

function allow(remaining: number | null): Decision {
  return { allowed: true, remaining }
}

function refuse(refusal: Refusal): Decision {
  return { allowed: false, remaining: 0, refusal }
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants and fallbacks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What FREE means when the Plan row cannot be read.
 *
 * Plans are seeded, so this should be unreachable — which is exactly why it has
 * to exist. A truncated table, a seed that was never run on a fresh
 * environment, or a migration mid-flight must not turn "no plan row" into "no
 * limits". These numbers duplicate prisma/seed.ts deliberately: the seed owns
 * what ops can edit, and this is the floor for when it has not run. The
 * fallback is the strictest tier, never the loosest.
 */
export const FREE_MAX_ITINERARY_DAYS = 2
export const FREE_MAX_SAVED_ITINERARIES = 3

/**
 * AI planner turns a FREE account gets in one calendar month.
 *
 * Thirty, and the number is a spend ceiling rather than a product boundary. A
 * free account is deliberately unmetered on `itinerariesPerPeriod` — its
 * 3-saved ceiling bounds what it may KEEP — but nothing bounded what it may
 * ASK, and every turn is a paid model call against `ai.maxOutputTokens`. Thirty
 * covers roughly ten trips at three turns each, which is far more planning than
 * the three slots can hold, so a genuine free traveller never meets this wall;
 * a scripted one meets it on the thirty-first call instead of the ten-thousandth.
 *
 * Duplicated in prisma/seed.ts on purpose, exactly like the two constants above:
 * the seed owns what ops can edit, and this is the floor for when it has not run.
 */
export const FREE_AI_PROMPTS_PER_PERIOD = 30

/** The seeded price of the one-off unlock, used when the settings row is unreadable. */
export const DEFAULT_UNLOCK_PRICE_BDT = 200

/** The settings key ops edits to reprice the one-off unlock. */
export const UNLOCK_PRICE_SETTING_KEY = 'payments.itineraryUnlockPriceBdt'

/** The entry premium tier, and so the tier a wall points at by default. */
export const DEFAULT_UPGRADE_PLAN = PlanCode.PREMIUM_10

/**
 * Whole taka only, and never negative.
 *
 * A price that arrived as a float or a string is a misconfiguration, and
 * quoting "199.99 BDT" for a product whose every column is an Int is worse than
 * quoting the seeded default.
 */
const UnlockPriceSchema = z.number().int().min(0)

/**
 * Which statuses occupy one of a free account's saved slots.
 *
 * A DRAFT is work in progress, not a saved trip — otherwise abandoning a
 * half-finished plan would cost a slot forever and the cap would be a cap on
 * *attempts*. A CANCELLED trip is not occupying anything either. Everything
 * from SAVED onward is a trip the traveller chose to keep, including the ones
 * that went on to be booked.
 */
export const SAVED_ITINERARY_STATUSES = [
  ItineraryStatus.SAVED,
  ItineraryStatus.SUBMITTED,
  ItineraryStatus.QUOTED,
  ItineraryStatus.ACCEPTED,
  ItineraryStatus.BOOKED,
  ItineraryStatus.COMPLETED,
] as const

const PLAN_LIMIT_SELECT = {
  code: true,
  name: true,
  maxItineraryDays: true,
  maxSavedItineraries: true,
  itinerariesPerPeriod: true,
  aiPromptsPerPeriod: true,
} as const

/**
 * Which subscription rows are a subscription at all.
 *
 * ACTIVE and paid through are the obvious halves. The third clause is the one
 * that stops a 200 BDT purchase becoming a permanent account-wide upgrade:
 * UNLOCK_SINGLE is a Plan row with `interval = NONE`, and a payment handler
 * doing the obvious thing on settlement — create a Subscription from
 * `upgrade.planCode` — would otherwise hand the buyer a plan that the
 * sortOrder tie-break ranks above FREE. The grant that purchase actually buys
 * is the ItineraryUnlock row, and nothing else.
 *
 * It is a WHERE clause and not a comment for the same reason expiry is: a
 * one-off row simply never matches, so there is no "is this a real
 * subscription?" branch anywhere for anyone to forget.
 */
const LIVE_SUBSCRIPTION = {
  status: SubscriptionStatus.ACTIVE,
  plan: { interval: { not: BillingInterval.NONE } },
} as const

// ─────────────────────────────────────────────────────────────────────────────
// The snapshot
// ─────────────────────────────────────────────────────────────────────────────

export interface PeriodUsage {
  itinerariesCreated: number
  aiPromptsUsed: number
}

export interface Entitlement {
  planCode: PlanCode
  /** How the plan is named to the traveller. */
  planName: string
  /** True for a visitor with no account. Every allowance below is then zero. */
  isAnonymous: boolean
  /** null = unlimited. FREE is 2. */
  maxItineraryDays: number | null
  /** null = unlimited. FREE is 3. */
  maxSavedItineraries: number | null
  /** null = unmetered per period. FREE is null; the saved cap bounds it instead. */
  itinerariesPerPeriod: number | null
  /** null = unmetered per period. FREE is finite — nothing else bounds AI spend. */
  aiPromptsPerPeriod: number | null
  savedCount: number
  periodUsage: PeriodUsage
  /** The metering window these counts belong to. */
  periodStart: Date
  periodEnd: Date
  /** Set only while a subscription is genuinely active and paid through. */
  subscriptionId: string | null
  /** The one-off unlock price in force, so no client ever hard-codes 200. */
  unlockPriceBdt: number
}

/**
 * The entitlement of somebody who has not signed in.
 *
 * Zeros, not the FREE plan's numbers. An anonymous visitor gets exactly one
 * teaser and nothing else: no generation, no saving. Returning FREE's 2 and 3
 * here would be the sort of quiet default that hands an account's worth of
 * product to somebody who never made one.
 *
 * Computed without touching the database, so the anonymous path stays cheap —
 * which matters, because the anonymous path is the one strangers can call.
 */
export function anonymousEntitlement(now: Date = new Date()): Entitlement {
  const { start, end } = calendarMonth(now)

  return {
    planCode: PlanCode.FREE,
    planName: 'Visitor',
    isAnonymous: true,
    maxItineraryDays: 0,
    maxSavedItineraries: 0,
    itinerariesPerPeriod: 0,
    aiPromptsPerPeriod: 0,
    savedCount: 0,
    periodUsage: { itinerariesCreated: 0, aiPromptsUsed: 0 },
    periodStart: start,
    periodEnd: end,
    subscriptionId: null,
    unlockPriceBdt: DEFAULT_UNLOCK_PRICE_BDT,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Periods
//
// UsageCounter is unique on (userId, periodStart), which is what lets metering
// be an upsert-then-increment instead of a read-then-write. That only works if
// every caller derives the same boundary from the same inputs, so the rules
// below are pure functions of `now` and the subscription — never of whenever
// the counter row happened to be created.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * UTC calendar month. The metering window for anyone without a subscription.
 *
 * UTC rather than Asia/Dhaka is a deliberate simplification: the boundary only
 * groups a counter, and a six-hour disagreement about when the month turns over
 * does not justify a timezone dependency inside the meter.
 */
function calendarMonth(now: Date): { start: Date; end: Date } {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
  }
}

/** Month arithmetic that clamps rather than overflowing: 31 Mar − 1 month is 28 Feb. */
function addMonths(date: Date, months: number): Date {
  const dayOfMonth = date.getUTCDate()
  const shifted = new Date(date.getTime())

  // Move to the 1st first, or setUTCMonth on the 31st silently rolls forward
  // into the month after the one asked for.
  shifted.setUTCDate(1)
  shifted.setUTCMonth(shifted.getUTCMonth() + months)

  const daysInTargetMonth = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)
  ).getUTCDate()

  shifted.setUTCDate(Math.min(dayOfMonth, daysInTargetMonth))
  return shifted
}

/**
 * The metering window in force.
 *
 * A subscriber's window is their billing month, ending at `currentPeriodEnd` —
 * the same boundary a renewal payment moves — so a "10 itineraries a month"
 * allowance resets when they are charged, not when the calendar turns over. An
 * account with no live subscription has no billing anything, so it gets the UTC
 * calendar month.
 */
export function resolvePeriod(
  now: Date,
  currentPeriodEnd: Date | null
): { start: Date; end: Date } {
  if (currentPeriodEnd === null) return calendarMonth(now)
  return { start: addMonths(currentPeriodEnd, -1), end: currentPeriodEnd }
}

/** The unlock price in force: the settings row if it is sane, the seeded default otherwise. */
export async function unlockPriceBdt(): Promise<number> {
  const configured = await readCachedSetting(UNLOCK_PRICE_SETTING_KEY, UnlockPriceSchema)
  return configured ?? DEFAULT_UNLOCK_PRICE_BDT
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything that governs what one account may do right now.
 *
 * An expired subscription falls back to FREE silently, and the query is what
 * makes it silent: `currentPeriodEnd > now` is part of the WHERE clause, so a
 * lapsed row simply does not match and there is no "is it still valid?" branch
 * anywhere for anyone to forget. A PENDING subscription — created, not yet paid
 * for — does not match either, which is the difference between selling a plan
 * and giving one away.
 */
export async function resolveEntitlement(
  userId: string | null,
  now: Date = new Date()
): Promise<Entitlement> {
  if (userId === null) return anonymousEntitlement(now)

  const [subscription, freePlan, unlockPrice] = await Promise.all([
    db.subscription.findFirst({
      where: {
        userId,
        ...LIVE_SUBSCRIPTION,
        currentPeriodEnd: { gt: now },
      },
      // The strongest plan wins when two overlap, and the furthest-running row
      // breaks the tie. An upgrade bought mid-month must not be shadowed by the
      // tier it replaced just because Postgres returned that row first.
      orderBy: [{ plan: { sortOrder: 'desc' } }, { currentPeriodEnd: 'desc' }],
      select: { id: true, currentPeriodEnd: true, plan: { select: PLAN_LIMIT_SELECT } },
    }),
    db.plan.findUnique({ where: { code: PlanCode.FREE }, select: PLAN_LIMIT_SELECT }),
    unlockPriceBdt(),
  ])

  const plan = subscription?.plan ?? freePlan
  const period = resolvePeriod(now, subscription?.currentPeriodEnd ?? null)

  const [savedCount, counter] = await Promise.all([
    db.itinerary.count({
      where: { userId, status: { in: [...SAVED_ITINERARY_STATUSES] } },
    }),
    db.usageCounter.findUnique({
      where: { userId_periodStart: { userId, periodStart: period.start } },
      select: { itinerariesCreated: true, aiPromptsUsed: true },
    }),
  ])

  return {
    planCode: plan?.code ?? PlanCode.FREE,
    planName: plan?.name ?? 'Free',
    isAnonymous: false,
    // `plan ? plan.x : FALLBACK` rather than `plan?.x ?? FALLBACK`: the second
    // form cannot tell "no plan row" from "the plan says unlimited", and would
    // silently downgrade every premium account to the free tier's caps.
    maxItineraryDays: plan ? plan.maxItineraryDays : FREE_MAX_ITINERARY_DAYS,
    maxSavedItineraries: plan ? plan.maxSavedItineraries : FREE_MAX_SAVED_ITINERARIES,
    itinerariesPerPeriod: plan ? plan.itinerariesPerPeriod : null,
    aiPromptsPerPeriod: plan ? plan.aiPromptsPerPeriod : FREE_AI_PROMPTS_PER_PERIOD,
    savedCount,
    periodUsage: {
      itinerariesCreated: counter?.itinerariesCreated ?? 0,
      aiPromptsUsed: counter?.aiPromptsUsed ?? 0,
    },
    periodStart: period.start,
    periodEnd: period.end,
    subscriptionId: subscription?.id ?? null,
    unlockPriceBdt: unlockPrice,
  }
}

/** Resolve the entitlement behind an actor, whichever kind it is. */
export async function resolveActorEntitlement(
  actor: Actor,
  now: Date = new Date()
): Promise<Entitlement> {
  return resolveEntitlement(actor.kind === 'user' ? actor.userId : null, now)
}

/** Whether this specific itinerary has been bought outright. */
export async function isItineraryUnlocked(userId: string, itineraryId: string): Promise<boolean> {
  // The record of truth is this row, never `Itinerary.isFullyUnlocked` — that
  // column is a denormalised cache for list views, recomputed from here.
  // Reading the cache to decide an entitlement would turn a stale write into a
  // free upgrade.
  const unlock = await db.itineraryUnlock.findUnique({
    where: { userId_itineraryId: { userId, itineraryId } },
    select: { id: true },
  })
  return unlock !== null
}

// ─────────────────────────────────────────────────────────────────────────────
// Offers
// ─────────────────────────────────────────────────────────────────────────────

function signInOffer(): UpgradeOffer {
  return { action: 'SIGN_IN', planCode: PlanCode.FREE, priceBdt: 0, label: 'Create a free account' }
}

function unlockOffer(itineraryId: string, priceBdt: number): UpgradeOffer {
  return {
    action: 'UNLOCK_ITINERARY',
    planCode: PlanCode.UNLOCK_SINGLE,
    priceBdt,
    label: `Unlock this itinerary in full for ${priceBdt} BDT`,
    itineraryId,
  }
}

function subscribeOffer(label: string): UpgradeOffer {
  return { action: 'SUBSCRIBE', planCode: DEFAULT_UPGRADE_PLAN, priceBdt: null, label }
}

// ─────────────────────────────────────────────────────────────────────────────
// Day allowance
// ─────────────────────────────────────────────────────────────────────────────

export type DayAllowanceSource = 'ANONYMOUS' | 'UNLOCK' | 'SUBSCRIPTION' | 'PLAN'

export interface DayAllowance {
  /** Days of detail this actor may generate right now. Zero means none at all. */
  maxDays: number
  /** True when nothing caps the length; `maxDays` is then the product-wide ceiling. */
  unlimited: boolean
  /** True when an ItineraryUnlock row exists for this user and this itinerary. */
  unlocked: boolean
  source: DayAllowanceSource
  entitlement: Entitlement
  /** Set whenever `maxDays` is a cap that money — or an account — would lift. */
  refusal: Refusal | null
}

/**
 * How many days this actor may generate for this itinerary.
 *
 * The order of the checks is the product:
 *
 *   1. Anonymous gets zero. The teaser is the only anonymous surface.
 *   2. A paid unlock on THIS itinerary beats everything else — that is what the
 *      200 taka bought, and it is permanent.
 *   3. An active subscription with no day cap covers whatever they generate.
 *   4. Otherwise the plan's cap applies. On FREE that is 2.
 *
 * Note what this does *not* do: it never throws for asking too much. A FREE
 * traveller who wants seven days gets two days and an explanation, not a 403.
 * That is why it returns a number with a `refusal` beside it rather than a
 * yes/no — the ordinary outcome is a partial success that has to be narrated.
 *
 * `itineraryId` is optional because the first generation happens before an
 * itinerary row exists. There is nothing to have unlocked yet, so the answer is
 * the plan's cap, which is the correct and conservative reading.
 */
export async function canGenerateDays(
  actor: Actor,
  itineraryId?: string | null,
  entitlement?: Entitlement
): Promise<DayAllowance> {
  const resolved = entitlement ?? (await resolveActorEntitlement(actor))

  if (actor.kind === 'anonymous') {
    return {
      maxDays: 0,
      unlimited: false,
      unlocked: false,
      source: 'ANONYMOUS',
      entitlement: resolved,
      refusal: {
        reason: 'FREE_DAY_LIMIT',
        message:
          'Sign in to build a day-by-day itinerary. A preview is as far as we go anonymously.',
        upgrade: signInOffer(),
      },
    }
  }

  const unlocked = itineraryId != null && (await isItineraryUnlocked(actor.userId, itineraryId))

  if (unlocked) {
    return {
      maxDays: MAX_TRIP_DAYS,
      unlimited: true,
      unlocked: true,
      source: 'UNLOCK',
      entitlement: resolved,
      refusal: null,
    }
  }

  if (resolved.maxItineraryDays === null) {
    return {
      maxDays: MAX_TRIP_DAYS,
      unlimited: true,
      unlocked: false,
      source: resolved.subscriptionId !== null ? 'SUBSCRIPTION' : 'PLAN',
      entitlement: resolved,
      refusal: null,
    }
  }

  const cap = Math.max(0, resolved.maxItineraryDays)

  return {
    maxDays: cap,
    unlimited: false,
    unlocked: false,
    source: 'PLAN',
    entitlement: resolved,
    refusal: {
      reason: 'FREE_DAY_LIMIT',
      message:
        `${resolved.planName} plans the first ${cap} ${cap === 1 ? 'day' : 'days'} of a trip. ` +
        `Unlocking this itinerary for ${resolved.unlockPriceBdt} BDT plans the whole thing, ` +
        'once, forever — or a monthly plan lifts the limit on everything.',
      upgrade:
        itineraryId != null
          ? unlockOffer(itineraryId, resolved.unlockPriceBdt)
          : subscribeOffer('Go monthly for full-length itineraries'),
    },
  }
}

/**
 * Clamp a requested length to what the actor may actually have.
 *
 * Exists so no route writes `Math.min` itself. The requested number came from
 * the client, and the whole point of this module is that a client-supplied day
 * count is an opinion, not an input to enforcement.
 */
export function daysToGenerate(requestedDays: number, allowance: DayAllowance): number {
  const requested = Math.min(MAX_TRIP_DAYS, Math.max(0, Math.trunc(requestedDays)))
  return Math.min(requested, allowance.maxDays)
}

// ─────────────────────────────────────────────────────────────────────────────
// Saving
// ─────────────────────────────────────────────────────────────────────────────

export interface SaveOptions {
  /**
   * True when this itinerary already occupies a saved slot. Re-saving it must
   * not be refused for being the fourth of three — it is not a fourth. Without
   * this, editing a trip at the cap would be impossible for the accounts most
   * likely to be at it.
   */
  alreadySaved?: boolean
}

/**
 * May this actor keep another itinerary?
 *
 * Two different ceilings, checked in that order. FREE is bounded by how many
 * trips it may hold at once (3) — a stock, which deleting one frees up. Premium
 * is bounded by how many it may create per billing month — a flow, which
 * deleting does not refund. An account can be blocked by either, and the reason
 * codes differ because the two walls need different copy: one says "delete one
 * or upgrade", the other says "wait for the reset".
 */
export async function canSaveItinerary(
  actor: Actor,
  options: SaveOptions = {},
  entitlement?: Entitlement
): Promise<Decision> {
  if (actor.kind === 'anonymous') {
    return refuse({
      reason: 'SAVE_LIMIT',
      message: 'Sign in to save an itinerary and come back to it later.',
      upgrade: signInOffer(),
    })
  }

  const resolved = entitlement ?? (await resolveActorEntitlement(actor))

  return decideSave(resolved, resolved.savedCount, options.alreadySaved === true)
}

/**
 * The save rules, as a pure function of a count.
 *
 * Split out because the count has two sources that must not be allowed to
 * disagree: the snapshot on the entitlement, which `canSaveItinerary` reports
 * from, and a fresh count taken inside `claimSaveSlot`'s transaction, which is
 * what actually enforces. One copy of the thresholds and one copy of every
 * message, so the wall a client is shown in advance is the wall it hits.
 */
function decideSave(
  entitlement: Entitlement,
  savedCount: number,
  alreadySaved: boolean
): Decision {
  const { maxSavedItineraries, itinerariesPerPeriod, periodUsage } = entitlement

  const remainingSaves =
    maxSavedItineraries === null ? null : Math.max(0, maxSavedItineraries - savedCount)
  const remainingPeriod =
    itinerariesPerPeriod === null
      ? null
      : Math.max(0, itinerariesPerPeriod - periodUsage.itinerariesCreated)

  // An itinerary that already holds a slot consumes neither allowance again.
  if (alreadySaved) return allow(remainingSaves ?? remainingPeriod)

  if (maxSavedItineraries !== null && savedCount >= maxSavedItineraries) {
    return refuse({
      reason: 'SAVE_LIMIT',
      message:
        `${entitlement.planName} keeps ${maxSavedItineraries} saved itineraries at a time, and ` +
        `you have ${savedCount}. Delete one, or move to a monthly plan to keep more.`,
      upgrade: subscribeOffer('Go monthly for unlimited saved trips'),
    })
  }

  if (itinerariesPerPeriod !== null && periodUsage.itinerariesCreated >= itinerariesPerPeriod) {
    return refuse(periodItineraryRefusal(entitlement, itinerariesPerPeriod))
  }

  // Whichever ceiling binds first is what the traveller actually has left. Both
  // null is a plan with no ceiling at all.
  const remaining =
    remainingSaves === null
      ? remainingPeriod
      : remainingPeriod === null
        ? remainingSaves
        : Math.min(remainingSaves, remainingPeriod)

  return allow(remaining)
}

/**
 * How many times a lost race is worth re-running before giving up.
 *
 * Serializable aborts are not failures, they are the isolation level doing its
 * job, and a genuine abort means the losing transaction should simply look
 * again — by which point it may well still have a slot. Three, because the
 * contention here is one account saving from several tabs, not a hot table.
 */
const MAX_CLAIM_ATTEMPTS = 3

/** Postgres serialization failure / deadlock, as Prisma reports it. */
const TRANSACTION_CONFLICT = 'P2034'

function isTransactionConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === TRANSACTION_CONFLICT
}

export interface SaveClaim {
  /** Allowed or refused, with the reason and offer a refusal carries. */
  decision: Decision
  /** True when THIS call is the one that moved the itinerary out of DRAFT. */
  claimed: boolean
}

/**
 * Take one saved slot for this itinerary, atomically. The binding decision.
 *
 * `canSaveItinerary` is advisory in exactly the way `canPrompt` is: it counts,
 * compares in JavaScript, and hands the answer back to a caller that then
 * writes. Between the count and the write, anything may happen. The attack is
 * cheap and complete — creation is uncapped, so a FREE account makes eight
 * DRAFTs and fires eight concurrent POSTs to /itineraries/{id}/save. All eight
 * count 0, all eight pass a cap of 3, all eight write. A cap sold as three,
 * delivered as eight, for the price of opening eight tabs.
 *
 * So the count and the write happen inside ONE Serializable transaction.
 * Postgres takes predicate locks over the rows the COUNT examined; a concurrent
 * transaction turning another DRAFT into a SAVED row falls inside that
 * predicate, which makes the two transactions mutually dependent and forces one
 * of them to abort rather than letting both commit. The retry loop then re-runs
 * the loser against committed state, where it either finds the slot it was
 * promised or is refused with a true count.
 *
 * The UPDATE carries its own predicate — `status: DRAFT`, scoped on `userId` —
 * so the transaction can only ever consume the slot it counted for, and a second
 * request for the SAME itinerary affects zero rows and consumes nothing.
 *
 * The PERIOD_LIMIT ceiling needs no such protection here: saving does not touch
 * `UsageCounter.itinerariesCreated`. That counter is claimed, atomically and
 * with the same discipline, by `claimItineraryCreation` at generation time.
 */
export async function claimSaveSlot(
  userId: string,
  itineraryId: string,
  now: Date = new Date()
): Promise<SaveClaim> {
  // Plan limits and the metering window are stable for the length of a request,
  // and reading them inside the transaction would widen it for no benefit. The
  // only value that has to be fresh is the saved count, and it is re-read below.
  const entitlement = await resolveEntitlement(userId, now)

  for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(
        async (tx): Promise<SaveClaim> => {
          const current = await tx.itinerary.findFirst({
            where: { id: itineraryId, userId },
            select: { status: true },
          })

          // Deleted between the caller's ownership check and this claim. Not an
          // entitlement problem, and it must not burn a slot.
          if (current === null) throw notFound('That itinerary was not found.')

          // Anything already out of DRAFT holds its slot (or, if CANCELLED,
          // holds nothing and is not being asked to). Either way there is
          // nothing left to claim, and refusing here would leave an account at
          // its cap unable to touch the trips it already has.
          if (current.status !== ItineraryStatus.DRAFT) {
            return { decision: decideSave(entitlement, entitlement.savedCount, true), claimed: false }
          }

          const savedCount = await tx.itinerary.count({
            where: { userId, status: { in: [...SAVED_ITINERARY_STATUSES] } },
          })

          const decision = decideSave(entitlement, savedCount, false)
          if (!decision.allowed) return { decision, claimed: false }

          const claimed = await tx.itinerary.updateMany({
            where: { id: itineraryId, userId, status: ItineraryStatus.DRAFT },
            data: { status: ItineraryStatus.SAVED },
          })

          // Zero rows cannot happen under Serializable — the status read above
          // would have conflicted first — but if it ever does, the itinerary is
          // out of DRAFT and the caller has the outcome they asked for.
          return { decision, claimed: claimed.count === 1 }
        },
        { isolationLevel: 'Serializable' }
      )
    } catch (e) {
      if (isTransactionConflict(e) && attempt < MAX_CLAIM_ATTEMPTS) continue
      throw e
    }
  }

  // Every attempt lost its race, which means saves are arriving faster than
  // they can be settled. A 409 says "try again" honestly; a refusal would claim
  // the cap was reached when it may not have been.
  throw conflict('That itinerary could not be saved just now. Please try again.')
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * May this actor send an AI prompt?
 *
 * Anonymous: exactly one, ever, counted on the AnonymousVisitor row that
 * `identifyVisitor` resolved. This check is advisory — it produces the message
 * and the offer. The binding decision is `consumePrompt`, whose predicate
 * Postgres evaluates under a row lock; a check here followed by a write there
 * is a read-then-write race, and the write is deliberately the half that
 * enforces.
 *
 * An actor with no visitor id is refused rather than waved through. That state
 * means identification did not happen, and an unidentifiable caller is the one
 * case where handing out a free generation is definitely wrong.
 *
 * Signed in: metered against TWO ceilings, and it takes both to be safe.
 *
 * `itinerariesPerPeriod` is the product allowance — every prompt exists to
 * produce an itinerary, so a subscriber who has used their ten has nothing left
 * to prompt for. `aiPromptsPerPeriod` is the spend allowance, and it is the one
 * that was missing: FREE seeds `itinerariesPerPeriod: null`, so metering only
 * that ceiling meant every free account passed forever and `aiPromptsUsed` was
 * a column nothing read. A free account could hold three saved trips and still
 * bill us for ten thousand model calls refining them.
 *
 * Both are null-means-unlimited, and both are tested for null first.
 */
export async function canPrompt(actor: Actor, entitlement?: Entitlement): Promise<Decision> {
  if (actor.kind === 'anonymous') {
    const exhausted: Refusal = {
      reason: 'ANON_PROMPT_EXHAUSTED',
      message: 'You have used your free preview. Log in to continue planning.',
      upgrade: signInOffer(),
    }

    if (actor.visitorId === null) return refuse(exhausted)

    const [limit, visitor] = await Promise.all([
      anonymousPromptLimit(),
      db.anonymousVisitor.findUnique({
        where: { id: actor.visitorId },
        select: { promptsUsed: true },
      }),
    ])

    // A visitor id that resolves to nothing is a forged or deleted row. Fail
    // closed: there is no quota here to spend against.
    if (visitor === null || visitor.promptsUsed >= limit) return refuse(exhausted)

    return allow(limit - visitor.promptsUsed)
  }

  const resolved = entitlement ?? (await resolveActorEntitlement(actor))
  const { itinerariesPerPeriod, aiPromptsPerPeriod, periodUsage } = resolved

  if (itinerariesPerPeriod !== null && periodUsage.itinerariesCreated >= itinerariesPerPeriod) {
    return refuse(periodItineraryRefusal(resolved, itinerariesPerPeriod))
  }

  if (aiPromptsPerPeriod !== null && periodUsage.aiPromptsUsed >= aiPromptsPerPeriod) {
    return refuse(periodPromptRefusal(resolved, aiPromptsPerPeriod))
  }

  const remainingItineraries =
    itinerariesPerPeriod === null ? null : itinerariesPerPeriod - periodUsage.itinerariesCreated
  const remainingPrompts =
    aiPromptsPerPeriod === null ? null : aiPromptsPerPeriod - periodUsage.aiPromptsUsed

  return allow(smallerRemaining(remainingItineraries, remainingPrompts))
}

/** The binding ceiling is whichever leaves less. Both null is no ceiling at all. */
function smallerRemaining(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

/** "You have used your itineraries for the month." One wording, four callers. */
function periodItineraryRefusal(entitlement: Entitlement, ceiling: number): Refusal {
  return {
    reason: 'PERIOD_LIMIT',
    message:
      `You have used all ${ceiling} itineraries included in ${entitlement.planName} this month. ` +
      'The allowance resets at the start of your next billing period.',
    upgrade: subscribeOffer('Move to a larger monthly plan'),
  }
}

/**
 * "You have used your planner messages for the month."
 *
 * Deliberately the same PERIOD_LIMIT code as the itinerary ceiling. The code is
 * a closed vocabulary mirrored field-for-field by the web app, and both walls
 * mean the same thing to a client — wait for the reset, or buy a bigger
 * allowance. Only the sentence differs, and the sentence is not the contract.
 */
function periodPromptRefusal(entitlement: Entitlement, ceiling: number): Refusal {
  return {
    reason: 'PERIOD_LIMIT',
    message:
      `You have used all ${ceiling} planner messages included in ${entitlement.planName} this ` +
      'month. The allowance resets at the start of your next billing period.',
    upgrade: subscribeOffer('Move to a monthly plan for more planning'),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Metering
// ─────────────────────────────────────────────────────────────────────────────

export interface UsageDelta {
  itinerariesCreated?: number
  aiPromptsUsed?: number
}

/**
 * The metering window this account is in right now.
 *
 * Re-derived from the database rather than taken from a caller-held snapshot,
 * so a request that started just before a billing boundary cannot write its
 * usage into a window that has already closed. Shares `LIVE_SUBSCRIPTION` with
 * `resolveEntitlement`, so a one-off UNLOCK_SINGLE row cannot move an account's
 * period here either — a counter keyed on a period nothing else agrees with is
 * a counter no limit can be enforced against.
 */
async function currentPeriod(userId: string, now: Date): Promise<{ start: Date; end: Date }> {
  const subscription = await db.subscription.findFirst({
    where: { userId, ...LIVE_SUBSCRIPTION, currentPeriodEnd: { gt: now } },
    orderBy: [{ plan: { sortOrder: 'desc' } }, { currentPeriodEnd: 'desc' }],
    select: { currentPeriodEnd: true },
  })

  return resolvePeriod(now, subscription?.currentPeriodEnd ?? null)
}

/**
 * Add to a signed-in account's counters for the current period.
 *
 * An upsert keyed on the compound unique, with an atomic increment in its
 * update branch — the pattern that index exists to enable. Two concurrent
 * generations therefore add to the same row instead of one silently
 * overwriting the other's total, which is the same class of bug as an anonymous
 * read-then-write and has the same fix.
 *
 * Unconditional by design: this is the meter, not the gate. Where an allowance
 * has to be ENFORCED — the generation path — the check and the increment are one
 * predicate-bearing statement in `claimItineraryCreation` instead.
 */
export async function recordUsage(
  userId: string,
  delta: UsageDelta,
  now: Date = new Date()
): Promise<void> {
  const itinerariesCreated = Math.max(0, Math.trunc(delta.itinerariesCreated ?? 0))
  const aiPromptsUsed = Math.max(0, Math.trunc(delta.aiPromptsUsed ?? 0))
  if (itinerariesCreated === 0 && aiPromptsUsed === 0) return

  const period = await currentPeriod(userId, now)

  await db.usageCounter.upsert({
    where: { userId_periodStart: { userId, periodStart: period.start } },
    create: {
      userId,
      periodStart: period.start,
      periodEnd: period.end,
      itinerariesCreated,
      aiPromptsUsed,
    },
    update: {
      itinerariesCreated: { increment: itinerariesCreated },
      aiPromptsUsed: { increment: aiPromptsUsed },
    },
    select: { id: true },
  })
}

/** What materialising one itinerary costs: the product allowance, and one turn of spend. */
const ITINERARY_USAGE: Required<UsageDelta> = { itinerariesCreated: 1, aiPromptsUsed: 1 }

/**
 * Claim one itinerary from the per-period allowance. The binding decision.
 *
 * This is the gate the generation path did not have. `canGenerateDays` only
 * ever inspected `maxItineraryDays`, and every PREMIUM tier seeds that null — so
 * it returned "unlimited" unconditionally and `itinerariesPerPeriod` was
 * enforced nowhere that produced an itinerary. A PREMIUM_10 subscriber who had
 * used their ten kept generating full-length trips forever, against a counter
 * that was incremented and never read.
 *
 * The claim is `consumePrompt`'s discipline applied to a different row: the
 * ceilings live in the WHERE clause of a single `UPDATE`, so Postgres takes a
 * row lock and re-evaluates them against committed state. Two concurrent
 * generations at 9 of 10 therefore see 9 and then 10, and exactly one comes back
 * with a count of 1. Zero rows affected is a refusal — never a shrug.
 *
 * Both ceilings are claimed together because both are spent together. A
 * generation costs one itinerary from the product allowance and one turn from
 * the AI allowance, and splitting them into two statements would reintroduce the
 * gap between them.
 *
 * The counter row is created first so the predicate has something to bite on. An
 * account's very first generation of a period would otherwise match nothing and
 * be refused for having used an allowance it has not touched.
 */
export async function claimItineraryCreation(
  userId: string,
  now: Date = new Date()
): Promise<Decision> {
  const entitlement = await resolveEntitlement(userId, now)
  const { itinerariesPerPeriod, aiPromptsPerPeriod } = entitlement

  // No ceiling to claim against. Meter it and let it through — an unconditional
  // increment is correct here precisely because nothing is being enforced.
  if (itinerariesPerPeriod === null && aiPromptsPerPeriod === null) {
    await recordUsage(userId, ITINERARY_USAGE, now)
    return allow(null)
  }

  const period = await currentPeriod(userId, now)

  // `periodEnd` in the update branch is the same value the create branch would
  // write, so this is a no-op on an existing row — but it gives Prisma a
  // non-empty SET, which is what lets the statement compile to a single
  // INSERT ... ON CONFLICT DO UPDATE rather than a racy select-then-insert.
  await db.usageCounter.upsert({
    where: { userId_periodStart: { userId, periodStart: period.start } },
    create: { userId, periodStart: period.start, periodEnd: period.end },
    update: { periodEnd: period.end },
    select: { id: true },
  })

  const claimed = await db.usageCounter.updateMany({
    where: {
      userId,
      periodStart: period.start,
      ...(itinerariesPerPeriod !== null
        ? { itinerariesCreated: { lt: itinerariesPerPeriod } }
        : {}),
      ...(aiPromptsPerPeriod !== null ? { aiPromptsUsed: { lt: aiPromptsPerPeriod } } : {}),
    },
    data: {
      itinerariesCreated: { increment: ITINERARY_USAGE.itinerariesCreated },
      aiPromptsUsed: { increment: ITINERARY_USAGE.aiPromptsUsed },
    },
  })

  if (claimed.count === 0) {
    return refuse(await exhaustedPeriodRefusal(userId, entitlement, period.start))
  }

  // A report, not an enforcement: the snapshot it is derived from was read
  // before the claim, so under concurrency it may be one or two generous. The
  // number that binds is the predicate above.
  return allow(
    smallerRemaining(
      itinerariesPerPeriod === null
        ? null
        : Math.max(0, itinerariesPerPeriod - entitlement.periodUsage.itinerariesCreated - 1),
      aiPromptsPerPeriod === null
        ? null
        : Math.max(0, aiPromptsPerPeriod - entitlement.periodUsage.aiPromptsUsed - 1)
    )
  )
}

/**
 * Which ceiling refused the claim, read back from the row that refused it.
 *
 * The pre-claim snapshot cannot answer this: it is what said the claim would
 * succeed. One extra query, only on the refusal path, buys a message that names
 * the wall the traveller actually hit rather than guessing between two.
 */
async function exhaustedPeriodRefusal(
  userId: string,
  entitlement: Entitlement,
  periodStart: Date
): Promise<Refusal> {
  const counter = await db.usageCounter.findUnique({
    where: { userId_periodStart: { userId, periodStart } },
    select: { itinerariesCreated: true, aiPromptsUsed: true },
  })

  const { itinerariesPerPeriod, aiPromptsPerPeriod } = entitlement

  if (
    aiPromptsPerPeriod !== null &&
    (counter?.aiPromptsUsed ?? entitlement.periodUsage.aiPromptsUsed) >= aiPromptsPerPeriod
  ) {
    return periodPromptRefusal(entitlement, aiPromptsPerPeriod)
  }

  // Whatever the counter says, the itinerary ceiling is the one this path is
  // about, so it is also the fallback when the row has vanished underneath us.
  return periodItineraryRefusal(entitlement, itinerariesPerPeriod ?? 0)
}

/**
 * Hand a claimed generation back after the generation failed.
 *
 * Same reasoning as `refundPrompt`: the allowance is claimed BEFORE the work,
 * because claiming it afterwards is the race this module exists to prevent, and
 * the consequence is that a failure would otherwise bill a subscriber for an
 * itinerary they never received. Guarded on `gt: 0` on both columns so it can
 * never push a counter negative — the `usage_counters_non_negative` CHECK would
 * reject that anyway, and turning a failed generation into a 500 helps nobody.
 */
export async function releaseItineraryCreation(
  userId: string,
  now: Date = new Date()
): Promise<void> {
  const period = await currentPeriod(userId, now)

  await db.usageCounter.updateMany({
    where: {
      userId,
      periodStart: period.start,
      itinerariesCreated: { gt: 0 },
      aiPromptsUsed: { gt: 0 },
    },
    data: {
      itinerariesCreated: { decrement: ITINERARY_USAGE.itinerariesCreated },
      aiPromptsUsed: { decrement: ITINERARY_USAGE.aiPromptsUsed },
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Handing the state to the model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate the snapshot into what the planner prompt accepts.
 *
 * `maxItineraryDays` is reported as the platform ceiling for an uncapped plan
 * rather than as "unlimited", because it is not unlimited: `MAX_TRIP_DAYS` is a
 * real bound, and a designer told "unlimited" will happily draft sixty days
 * that no schema will accept.
 */
export function toPromptEntitlement(
  entitlement: Entitlement,
  thisItineraryUnlocked: boolean
): EntitlementContext {
  const generationsRemaining =
    entitlement.itinerariesPerPeriod === null
      ? null
      : Math.max(0, entitlement.itinerariesPerPeriod - entitlement.periodUsage.itinerariesCreated)

  return {
    planLabel: entitlement.planName,
    maxItineraryDays: entitlement.maxItineraryDays ?? MAX_TRIP_DAYS,
    savedItineraries: entitlement.savedCount,
    maxSavedItineraries: entitlement.maxSavedItineraries,
    generationsRemaining,
    thisItineraryUnlocked,
    unlockPriceBdt: entitlement.unlockPriceBdt,
  }
}
