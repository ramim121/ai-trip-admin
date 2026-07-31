import { z } from 'zod'
import { BillingInterval, PlanCode } from '@/generated/prisma/enums'
import {
  MAX_PARTY_SIZE,
  MAX_TRIP_DAYS,
  TRIP_PURPOSES,
  TeaserResponseSchema,
} from '@/server/ai/schemas'
import { REFUSAL_REASONS, type Decision, type Entitlement, type Refusal } from './service'

/**
 * The wire contract for plans, entitlements and the anonymous teaser.
 *
 * Same rule as the auth schemas: every shape is named and exported so the
 * OpenAPI generator emits it as a component rather than inlining an anonymous
 * object at each call site, and the response schemas are the definition of what
 * leaves the process. A field absent here is a field no client can come to
 * depend on.
 *
 * What is deliberately *not* here is anything a client could send that would
 * change a limit. No `planCode` in a request body, no `isUnlocked`, no
 * `maxDays`. The server reads all of those from the database on every call;
 * accepting them would make the enforcement in service.ts decorative.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Plans
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One sellable tier, as the public site sees it.
 *
 * `code` is the identifier, not `id`. The uuid is a database detail that means
 * nothing to a client, whereas the code is stable across environments — the
 * same string in the seed, in the checkout and in a support conversation.
 *
 * Every limit is nullable and null means UNLIMITED. Clients must render that as
 * "unlimited", never as zero; each field says so, because this is the one
 * misreading that turns the most expensive plan into the most restrictive one.
 */
export const PlanSummary = z
  .object({
    code: z.enum(PlanCode),
    name: z.string(),
    description: z.string(),
    priceBdt: z
      .int()
      .nonnegative()
      .describe('Whole Bangladeshi taka. There is no minor unit and no fractional price.'),
    interval: z.enum(BillingInterval),
    maxItineraryDays: z
      .int()
      .nullable()
      .describe('Longest itinerary this plan may generate. `null` means no limit.'),
    maxSavedItineraries: z
      .int()
      .nullable()
      .describe('Itineraries that may be held at once. `null` means no limit.'),
    itinerariesPerPeriod: z
      .int()
      .nullable()
      .describe('Itineraries per billing month. `null` means unmetered.'),
    sortOrder: z.int(),
  })
  .meta({ id: 'PlanSummary' })
export type PlanSummary = z.infer<typeof PlanSummary>

export const PlanListResponse = z
  .object({
    plans: z.array(PlanSummary),
    bdtPerUsd: z
      .number()
      .positive()
      .nullable()
      .describe(
        'Admin-set display rate. USD is never stored: apply this at render time, so a rate ' +
          'change never rewrites a price that was already quoted. `null` when unconfigured, in ' +
          'which case show taka only.'
      ),
  })
  .meta({ id: 'PlanListResponse' })
export type PlanListResponse = z.infer<typeof PlanListResponse>

// ─────────────────────────────────────────────────────────────────────────────
// Entitlements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Annotated with the service's own union so the two cannot drift. Add a reason
 * in service.ts without adding it here and this line stops compiling, which is
 * cheaper than discovering the gap in the web repo.
 */
export const EntitlementReason: z.ZodType<Refusal['reason']> = z.enum(REFUSAL_REASONS).meta({
  id: 'EntitlementReason',
  description:
    'Machine-readable cause of a refusal. Branch on this, never on the message text. It also ' +
    'appears on a 403 as the `details` entry whose `path` is `reason`.',
})

export const UpgradeOffer = z
  .object({
    action: z.enum(['SIGN_IN', 'UNLOCK_ITINERARY', 'SUBSCRIBE']),
    planCode: z.enum(PlanCode).nullable(),
    priceBdt: z
      .int()
      .nonnegative()
      .nullable()
      .describe(
        'Whole taka. `0` for SIGN_IN, which costs nothing. `null` for SUBSCRIBE, where the ' +
          'price depends on the tier chosen — read it from GET /api/v1/plans.'
      ),
    label: z.string(),
    itineraryId: z
      .uuid()
      .optional()
      .describe('Present for UNLOCK_ITINERARY: the itinerary the one-off payment would unlock.'),
  })
  .meta({ id: 'UpgradeOffer' })
export type UpgradeOffer = z.infer<typeof UpgradeOffer>

export const EntitlementRefusal = z
  .object({
    reason: EntitlementReason,
    message: z.string().describe('Safe to show a traveller. Wording is not part of the contract.'),
    upgrade: UpgradeOffer.nullable(),
  })
  .meta({ id: 'EntitlementRefusal' })
export type EntitlementRefusal = z.infer<typeof EntitlementRefusal>

/**
 * Walls this account is already against, reported before it hits them.
 *
 * Null means the action is allowed right now. Returning these alongside the
 * limits is what lets a client disable "save" with the correct explanation
 * attached, instead of discovering the answer by being refused.
 */
export const EntitlementRefusals = z
  .object({
    save: EntitlementRefusal.nullable(),
    prompt: EntitlementRefusal.nullable(),
  })
  .meta({ id: 'EntitlementRefusals' })

export const EntitlementsResponse = z
  .object({
    planCode: z.enum(PlanCode),
    planName: z.string(),
    isAnonymous: z.boolean(),
    limits: z
      .object({
        maxItineraryDays: z.int().nullable(),
        maxSavedItineraries: z.int().nullable(),
        itinerariesPerPeriod: z.int().nullable(),
      })
      .describe('`null` on any field means unlimited, never zero.'),
    usage: z.object({
      savedItineraries: z.int().nonnegative(),
      itinerariesThisPeriod: z.int().nonnegative(),
      aiPromptsThisPeriod: z.int().nonnegative(),
    }),
    period: z.object({
      start: z.iso.datetime(),
      end: z.iso
        .datetime()
        .describe(
          'When the per-period counters reset: a subscriber’s billing month, or the UTC ' +
            'calendar month for everyone else.'
        ),
    }),
    unlockPriceBdt: z
      .int()
      .nonnegative()
      .describe('Current price of the one-off full-length unlock for a single itinerary.'),
    refusals: EntitlementRefusals,
  })
  .meta({ id: 'EntitlementsResponse' })
export type EntitlementsResponse = z.infer<typeof EntitlementsResponse>

// ─────────────────────────────────────────────────────────────────────────────
// Teaser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A best-effort device fingerprint from the browser.
 *
 * Untrusted, and treated as such: hashed with a server secret before it is
 * stored, and only ever one of three matching signals. A caller who invents a
 * fresh one on every request is still matched by the other two, and is still
 * metered by the rate limiter, which does not consult this field at all.
 *
 * REQUIRED, which it was not. Every one of the three identifying signals is
 * under the caller's control within a single request: omit the cookie, send no
 * fingerprint, and — on a deployment with no trusted proxy — resolve to no IP.
 * That combination identified nobody, and `identifyVisitor` used to answer
 * "nobody" by minting a fresh quota row, which is another free preview, for
 * every request that asked. Making this mandatory means a well-formed request
 * always carries at least one signal, so the unidentifiable case becomes a 400
 * about a missing field instead of a silent free generation.
 *
 * It is not a security control by itself — the value is still whatever the
 * caller typed. It removes "send nothing" as an option, and the limiter in
 * server/http/rate-limit.ts is what makes "send something new each time" cost
 * the attacker their address instead of costing us a model call.
 *
 * The length cap is here because an unbounded string from an anonymous caller
 * reaches a hash function on every request.
 */
const FingerprintField = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .describe(
    'Opaque device fingerprint. Required: a request with no cookie, no forwarded address and no ' +
      'fingerprint identifies nobody, and the server refuses those rather than minting a fresh ' +
      'free preview for each one. Hashed with a server secret before storage; never persisted raw.'
  )

/**
 * The four predefined answers, and nothing else.
 *
 * The bounds are the AI layer's own constants rather than numbers retyped here,
 * so what is validated, what is cached and what the model is asked about cannot
 * drift apart.
 *
 * There is no free-text field. The anonymous surface is a form, not a chat, and
 * keeping it that way is what makes the reply cacheable — which is what makes
 * bypass attempts cost no AI spend.
 */
export const TeaserRequest = z
  .object({
    destination: z.string().trim().min(1).max(120),
    totalDays: z.int().min(1).max(MAX_TRIP_DAYS),
    partySize: z.int().min(1).max(MAX_PARTY_SIZE),
    purpose: z.enum(TRIP_PURPOSES),
    deviceFingerprint: FingerprintField,
  })
  .meta({ id: 'TeaserRequest' })
export type TeaserRequest = z.infer<typeof TeaserRequest>

/** The preview itself. Its shape and its caps are defined by the AI layer. */
export const TeaserPreview = TeaserResponseSchema.meta({
  id: 'TeaserPreview',
  description:
    'A preview, not an itinerary: at most three broadly sketched days, no timings, no named ' +
    'venues, no prices. The full plan is what signing in is for.',
})

export const TeaserReply = z
  .object({
    teaser: TeaserPreview,
    cached: z
      .boolean()
      .describe(
        'True when this reply came from the cache rather than the model. It still spends the ' +
          'visitor’s prompt — the rule is one reply, not one model call.'
      ),
    promptsRemaining: z
      .int()
      .nonnegative()
      .nullable()
      .describe('Anonymous previews left for this visitor. `null` when the caller is signed in.'),
  })
  .meta({ id: 'TeaserReply' })
export type TeaserReply = z.infer<typeof TeaserReply>

// ─────────────────────────────────────────────────────────────────────────────
// Projections
// ─────────────────────────────────────────────────────────────────────────────

/** Exactly the columns `PlanSummary` needs. */
export interface PlanRow {
  code: PlanSummary['code']
  name: string
  description: string
  priceBdt: number
  interval: PlanSummary['interval']
  maxItineraryDays: number | null
  maxSavedItineraries: number | null
  itinerariesPerPeriod: number | null
  sortOrder: number
}

/** Written out field by field rather than spread, so a new column never leaks by default. */
export function toPlanSummary(row: PlanRow): PlanSummary {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    priceBdt: row.priceBdt,
    interval: row.interval,
    maxItineraryDays: row.maxItineraryDays,
    maxSavedItineraries: row.maxSavedItineraries,
    itinerariesPerPeriod: row.itinerariesPerPeriod,
    sortOrder: row.sortOrder,
  }
}

function refusalOf(decision: Decision): EntitlementRefusal | null {
  return decision.allowed ? null : decision.refusal
}

export function toEntitlementsResponse(
  entitlement: Entitlement,
  decisions: { save: Decision; prompt: Decision }
): EntitlementsResponse {
  return {
    planCode: entitlement.planCode,
    planName: entitlement.planName,
    isAnonymous: entitlement.isAnonymous,
    limits: {
      maxItineraryDays: entitlement.maxItineraryDays,
      maxSavedItineraries: entitlement.maxSavedItineraries,
      itinerariesPerPeriod: entitlement.itinerariesPerPeriod,
    },
    usage: {
      savedItineraries: entitlement.savedCount,
      itinerariesThisPeriod: entitlement.periodUsage.itinerariesCreated,
      aiPromptsThisPeriod: entitlement.periodUsage.aiPromptsUsed,
    },
    period: {
      start: entitlement.periodStart.toISOString(),
      end: entitlement.periodEnd.toISOString(),
    },
    unlockPriceBdt: entitlement.unlockPriceBdt,
    refusals: {
      save: refusalOf(decisions.save),
      prompt: refusalOf(decisions.prompt),
    },
  }
}
