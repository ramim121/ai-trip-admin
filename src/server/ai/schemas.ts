import { z } from 'zod'
import type {
  BudgetBand as PrismaBudgetBand,
  ItineraryBlockKind as PrismaBlockKind,
  TransportPreference as PrismaTransportPreference,
  TripPace as PrismaTripPace,
  TripPurpose as PrismaTripPurpose,
} from '@/generated/prisma/enums'

/**
 * The contract between the model and the application.
 *
 * Everything the AI produces re-enters our system through one of these schemas.
 * They are deliberately stricter than "valid JSON": a plan whose blocks overlap,
 * or an `ACTIVITY` block with no `activityId`, is a *product* failure even
 * though it parses, so it is rejected here rather than discovered by a traveller
 * standing outside a closed museum.
 *
 * The rule that matters most: activities come only from our curated catalog.
 * `activityId` is mandatory on activity blocks precisely so an invented
 * recommendation cannot survive validation — the id has to resolve against a
 * real row before the plan is persisted.
 */

// ── Vocabularies ────────────────────────────────────────────────────────────

/**
 * Const tuples rather than the generated Prisma objects, because zod needs an
 * ordered list and this file must stay usable with no database in sight.
 *
 * The values are not free, though: everything the model emits is eventually
 * written to an enum column, so a purpose the schema has never heard of is a
 * runtime insert failure. The assertions below turn that into a tsc error the
 * moment the two lists diverge — see `Exact` at the end of this section.
 */
export const TRIP_PURPOSES = [
  'VACATION',
  'BUSINESS',
  'HONEYMOON',
  'FAMILY',
  'SOLO',
  'GROUP',
  'OTHER',
] as const
export type TripPurpose = (typeof TRIP_PURPOSES)[number]

export const TRIP_PACES = ['RELAXED', 'BALANCED', 'PACKED'] as const
export type TripPace = (typeof TRIP_PACES)[number]

export const TRANSPORT_PREFERENCES = [
  'PRIVATE_CAR',
  'SELF_DRIVE',
  'PUBLIC_TRANSIT',
  'WALKING',
  'MIXED',
] as const
export type TransportPreference = (typeof TRANSPORT_PREFERENCES)[number]

export const BUDGET_BANDS = ['BUDGET', 'MID_RANGE', 'PREMIUM', 'LUXURY'] as const
export type BudgetBand = (typeof BUDGET_BANDS)[number]

export const DAY_BLOCK_KINDS = [
  'ACTIVITY',
  'TRANSIT',
  'MEAL',
  'REST',
  'FREE',
  'ACCOMMODATION',
] as const
export type DayBlockKind = (typeof DAY_BLOCK_KINDS)[number]

/**
 * Mutual assignability. A one-way `extends` would let the database grow a value
 * the planner can never produce and call it a match, which is exactly the drift
 * worth catching.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type AssertTrue<T extends true> = T

/* eslint-disable @typescript-eslint/no-unused-vars */
type _PurposesMatchSchema = AssertTrue<Exact<TripPurpose, PrismaTripPurpose>>
type _PacesMatchSchema = AssertTrue<Exact<TripPace, PrismaTripPace>>
type _TransportMatchesSchema = AssertTrue<Exact<TransportPreference, PrismaTransportPreference>>
type _BudgetBandsMatchSchema = AssertTrue<Exact<BudgetBand, PrismaBudgetBand>>
type _BlockKindsMatchSchema = AssertTrue<Exact<DayBlockKind, PrismaBlockKind>>
/* eslint-enable @typescript-eslint/no-unused-vars */

// ── Limits ──────────────────────────────────────────────────────────────────

export const MAX_TRIP_DAYS = 30
export const MAX_PARTY_SIZE = 40
export const MINUTES_IN_DAY = 1440
export const MAX_BLOCKS_PER_DAY = 14
/** The teaser is a preview, not an itinerary. This cap is what enforces that. */
export const MAX_TEASER_DAY_HIGHLIGHTS = 3
export const MAX_TEASER_SUGGESTED_INTERESTS = 6

const shortText = (max: number) => z.string().trim().min(1).max(max)

/**
 * Free-text lists the model fills in. Capped in both directions: an unbounded
 * array is a cheap way to blow the context window on the next turn.
 */
const tagList = (max: number, itemMax = 80) =>
  z.array(z.string().trim().min(1).max(itemMax)).max(max).default([])

// ── TripBrief ───────────────────────────────────────────────────────────────

/**
 * What we know about the trip so far.
 *
 * Every field is optional because the brief accumulates: the planner asks one
 * question at a time, and turn three must be able to persist a brief that still
 * has no start date. Completeness is a separate question, answered by
 * `tripBriefIsPlannable`, not by parsing.
 */
export const TripBriefSchema = z.object({
  destination: z.string().trim().min(1).max(120).optional(),
  /** Set once the destination is matched to a catalog row; free text until then. */
  destinationId: z.uuid().optional(),
  totalDays: z.number().int().min(1).max(MAX_TRIP_DAYS).optional(),
  /** Calendar date, not a timestamp — travellers pick a day, not an instant. */
  startDate: z.iso.date().optional(),
  partySize: z.number().int().min(1).max(MAX_PARTY_SIZE).optional(),
  purpose: z.enum(TRIP_PURPOSES).optional(),
  pace: z.enum(TRIP_PACES).optional(),
  transportPreference: z.enum(TRANSPORT_PREFERENCES).optional(),
  budgetBand: z.enum(BUDGET_BANDS).optional(),
  interests: tagList(20),
  mobilityNotes: z.string().trim().max(500).optional(),
  mustSee: tagList(20, 120),
  avoid: tagList(20, 120),
})

export type TripBrief = z.infer<typeof TripBriefSchema>
/** What a caller may hand in — array fields may be omitted. */
export type TripBriefInput = z.input<typeof TripBriefSchema>

/** The questionnaire fields the anonymous teaser is keyed and cached on. */
export const TEASER_QUESTIONNAIRE_FIELDS = [
  'destination',
  'totalDays',
  'partySize',
  'purpose',
] as const

/**
 * The four predefined answers an anonymous visitor gives. Unlike the brief,
 * these are all required: the teaser is a form submission, not a conversation.
 */
export const TeaserQuestionnaireSchema = z.object({
  destination: z.string().trim().min(1).max(120),
  totalDays: z.number().int().min(1).max(MAX_TRIP_DAYS),
  partySize: z.number().int().min(1).max(MAX_PARTY_SIZE),
  purpose: z.enum(TRIP_PURPOSES),
})

export type TeaserQuestionnaire = z.infer<typeof TeaserQuestionnaireSchema>

/**
 * Stable cache key for a questionnaire.
 *
 * The destination is slugified by exactly the rules `normaliseInterest` uses on
 * a tag (server/modules/catalog/service.ts): lowercased, NFKD-decomposed,
 * whitespace and underscores folded to hyphens, and everything that is not a
 * letter, a digit or a hyphen dropped. So "Cox's Bazar", "coxs  bazar " and
 * "COX'S BAZAR" are one entry, and so are `bangkok`, `bangkok.`, `bangkok!`,
 * `bängkok`, and `bangkok` typed with a U+00A0 space or a U+2019 apostrophe.
 *
 * This used to lowercase and collapse whitespace and nothing else, which left
 * punctuation and Unicode as free cache misses. That is not a cosmetic gap: the
 * cache is the ONLY thing that makes a bypass attempt cost no AI spend, so a
 * key that separates spellings of the same question is an abuse control that
 * does not work. Permuting punctuation was an uncached, unauthenticated model
 * call every time, as many times as somebody cared to type.
 *
 * NFKD before the character filter is what makes the accented forms collapse:
 * decomposition splits "ä" into "a" plus a combining diaeresis, and the filter
 * then drops the mark rather than the whole letter.
 */
export function teaserCacheKey(answers: TeaserQuestionnaire): string {
  const destination = answers.destination
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')

  return [destination, answers.totalDays, answers.partySize, answers.purpose].join('|')
}

/** The minimum needed to generate a day plan at all. */
export function tripBriefIsPlannable(brief: TripBrief): boolean {
  return Boolean(brief.destination && brief.totalDays && brief.partySize)
}

/**
 * Fold a turn's newly-learned facts into the running brief.
 *
 * Scalars overwrite (the traveller corrected themselves); lists union while
 * preserving order (they added an interest, they did not replace the list).
 * `undefined` never clears a known value — only an explicit new value does,
 * so a model that omits a field it was not asked about cannot erase it.
 */
export function mergeTripBrief(base: TripBrief, patch: Partial<TripBrief>): TripBrief {
  const union = (a: string[], b: string[] | undefined): string[] =>
    b === undefined ? a : [...new Set([...a, ...b])]

  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))

  return {
    ...base,
    ...defined,
    interests: union(base.interests, patch.interests),
    mustSee: union(base.mustSee, patch.mustSee),
    avoid: union(base.avoid, patch.avoid),
  }
}

// ── DayPlanProposal ─────────────────────────────────────────────────────────

/**
 * One slot in a day. Minutes are offsets from local midnight, which keeps the
 * model out of timezone arithmetic entirely — it reasons about "09:30", and we
 * resolve that against the destination when we render.
 */
export const DayBlockSchema = z
  .object({
    kind: z.enum(DAY_BLOCK_KINDS),
    /** Required for ACTIVITY blocks; must resolve to a catalog row. */
    activityId: z.uuid().optional(),
    title: shortText(160),
    startMinute: z
      .number()
      .int()
      .min(0)
      .max(MINUTES_IN_DAY - 1),
    /** May equal 1440 so a block can run to midnight. */
    endMinute: z.number().int().min(1).max(MINUTES_IN_DAY),
    rationale: z.string().trim().min(1).max(600),
  })
  .superRefine((block, ctx) => {
    if (block.endMinute <= block.startMinute) {
      ctx.addIssue({
        code: 'custom',
        path: ['endMinute'],
        message: 'endMinute must be after startMinute',
      })
    }

    // The catalog rule, enforced structurally: a recommendation the model
    // invented has no id to put here, so it cannot be expressed as an ACTIVITY.
    if (block.kind === 'ACTIVITY' && !block.activityId) {
      ctx.addIssue({
        code: 'custom',
        path: ['activityId'],
        message: 'ACTIVITY blocks must reference a catalog activity by id',
      })
    }

    // The mirror image: a meal or a transfer carrying an activity id is the
    // model routing sellable inventory around the catalog check.
    if (block.kind !== 'ACTIVITY' && block.activityId) {
      ctx.addIssue({
        code: 'custom',
        path: ['activityId'],
        message: `activityId is only valid on ACTIVITY blocks, not ${block.kind}`,
      })
    }
  })

export type DayBlock = z.infer<typeof DayBlockSchema>

export const DayPlanProposalSchema = z
  .object({
    dayNumber: z.number().int().min(1).max(MAX_TRIP_DAYS),
    title: shortText(160),
    blocks: z.array(DayBlockSchema).min(1).max(MAX_BLOCKS_PER_DAY),
  })
  .superRefine((day, ctx) => {
    // A day whose blocks overlap cannot be walked. Models produce this
    // regularly when padding a thin day, so it is checked, not trusted.
    for (let i = 1; i < day.blocks.length; i += 1) {
      const previous = day.blocks[i - 1]
      const current = day.blocks[i]
      if (current.startMinute < previous.endMinute) {
        ctx.addIssue({
          code: 'custom',
          path: ['blocks', i, 'startMinute'],
          message: `block ${i} starts at ${current.startMinute}, before block ${i - 1} ends at ${previous.endMinute}`,
        })
      }
    }
  })

export type DayPlanProposal = z.infer<typeof DayPlanProposalSchema>

/** Every catalog id a proposed day depends on, for a single existence check. */
export function referencedActivityIds(day: DayPlanProposal): string[] {
  const ids = day.blocks.flatMap((b) =>
    b.kind === 'ACTIVITY' && b.activityId ? [b.activityId] : []
  )
  return [...new Set(ids)]
}

// ── ActivitySuggestion ──────────────────────────────────────────────────────

/**
 * A single "you might like this" from the model, always pointing at inventory
 * we can actually sell.
 */
export const ActivitySuggestionSchema = z.object({
  activityId: z.uuid(),
  whyRecommended: z.string().trim().min(1).max(500),
  suggestedStartMinute: z
    .number()
    .int()
    .min(0)
    .max(MINUTES_IN_DAY - 1),
  /** The model's own confidence, 0–1. Used for ordering, never shown verbatim. */
  confidence: z.number().min(0).max(1),
})

export type ActivitySuggestion = z.infer<typeof ActivitySuggestionSchema>

// ── TeaserResponse ──────────────────────────────────────────────────────────

export const TeaserDayHighlightSchema = z.object({
  dayNumber: z.number().int().min(1).max(MAX_TRIP_DAYS),
  headline: shortText(120),
  summary: z.string().trim().min(1).max(400),
})

export type TeaserDayHighlight = z.infer<typeof TeaserDayHighlightSchema>

/**
 * The one reply an anonymous visitor ever gets.
 *
 * The caps are the product rule in schema form: at most three highlighted days
 * and no block-level detail, so the teaser can never quietly become the
 * itinerary the visitor was supposed to sign in for.
 */
export const TeaserResponseSchema = z.object({
  headline: shortText(120),
  overview: z.string().trim().min(1).max(800),
  dayHighlights: z.array(TeaserDayHighlightSchema).min(1).max(MAX_TEASER_DAY_HIGHLIGHTS),
  suggestedInterests: z
    .array(z.string().trim().min(1).max(60))
    .max(MAX_TEASER_SUGGESTED_INTERESTS)
    .default([]),
  callToAction: shortText(200),
})

export type TeaserResponse = z.infer<typeof TeaserResponseSchema>
