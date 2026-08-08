import { z } from 'zod'
import {
  BriefPillar,
  BudgetScope,
  DateBucket,
  DaySlot,
  ItemOrigin,
  ItemSource,
  JourneyItemType,
  JourneyStatus,
} from '@/generated/prisma/enums'

/**
 * The journey planner's wire contract.
 *
 * SEPARATE FROM ai-schema.ts DELIBERATELY. That one constrains what the MODEL
 * may return; this one constrains what the API accepts and emits. Merging them
 * would tie the public contract to a prompt's output shape, and every prompt
 * revision would become a breaking API change.
 *
 * EVERY PRICE THAT LEAVES HERE IS A RANGE AND IS LABELLED AN ESTIMATE. What is
 * sold is a quotation; these figures set expectations and fill a budget meter,
 * and the admin replaces them with real vendor prices. A single number would
 * read as a fare.
 *
 * WHAT NO REQUEST BODY CARRIES IS A PRICE. The client says what it wants added;
 * the server decides what it costs — the same rule the bookings and payments
 * modules state at length, and the reason an item's estimate is copied from the
 * provider snapshot rather than accepted from a browser.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Views
// ─────────────────────────────────────────────────────────────────────────────

export const EstimateView = z
  .object({
    minBdt: z.int().nonnegative().nullable(),
    maxBdt: z.int().nonnegative().nullable(),
    /** person | group | night | trip — what the range is per. */
    per: z.string().nullable(),
  })
  .meta({ id: 'EstimateView' })

export const JourneyItemView = z
  .object({
    id: z.uuid(),
    dayNumber: z.int().min(1),
    slot: z.enum(DaySlot),
    startMinute: z.int().min(0).max(1439).nullable().describe('Minutes from local midnight.'),
    durationMin: z.int().positive().nullable(),
    type: z.enum(JourneyItemType),
    origin: z
      .enum(ItemOrigin)
      .describe('USER_PINNED is a requirement; AI_SUGGESTED is a starting point.'),
    source: z.enum(ItemSource),
    externalId: z.string().nullable().describe('Viator product code or Google place id.'),
    activityId: z.uuid().nullable(),
    title: z.string(),
    description: z.string().nullable(),
    estimate: EstimateView,
    matchReason: z
      .string()
      .nullable()
      .describe('At most fifteen words, echoing the traveller back to themselves.'),
    locationName: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    /** Image, rating and deep link as the provider gave them at pick time. */
    snapshot: z.unknown().nullable(),
    briefId: z.uuid().nullable(),
    /**
     * The AI turn that created, moved or retimed this, if one did.
     *
     * Equal to the journey's `lastChangeSetId` exactly when this item is part of
     * the most recent change — which is how the interface says "these four are
     * what just happened" while holding no state of its own, and keeps saying it
     * after a reload.
     */
    changeSetId: z.uuid().nullable(),
  })
  .meta({ id: 'JourneyItemView' })

export const JourneyDayView = z
  .object({
    dayNumber: z.int().min(1),
    /** Where the traveller is that day. Also what makes transfer gaps findable. */
    locationName: z.string().nullable(),
    title: z.string().nullable(),
    /** One line we wrote about the shape of the day. Redrawn freely. */
    summary: z.string().nullable(),
    /** One the traveller wrote. Never overwritten by anything we generate. */
    note: z.string().nullable(),
  })
  .meta({
    id: 'JourneyDayView',
    description:
      'A day as a thing rather than an integer on an item. `summary` is ours and is redrawn ' +
      'whenever the day is; `note` is theirs and no generator may touch it.',
  })

export const PreferenceBriefView = z
  .object({
    id: z.uuid(),
    pillar: z.enum(BriefPillar),
    location: z.string(),
    nights: z.int().nullable(),
    constraints: z.unknown(),
    summary: z.string().describe('At most twenty-five words. What the chips say.'),
  })
  .meta({ id: 'PreferenceBriefView' })

export const ConflictView = z
  .object({
    dayNumber: z.int().min(1),
    itemIds: z.array(z.uuid()),
    message: z.string(),
  })
  .meta({ id: 'ConflictView' })

export const ValidationView = z
  .object({ status: z.enum(['valid', 'conflicts']), conflicts: z.array(ConflictView) })
  .meta({
    id: 'ValidationView',
    description:
      'Overlaps block a quotation request and never a save. A traveller mid-rearrange must not ' +
      'reach a state where their work will not persist.',
  })

export const BudgetView = z
  .object({
    estimatedMinBdt: z.int().nonnegative(),
    estimatedMaxBdt: z.int().nonnegative(),
    budgetMinBdt: z.int().nonnegative().nullable(),
    budgetMaxBdt: z.int().nonnegative().nullable(),
    fraction: z.number().min(0).max(1).nullable(),
    overBudget: z.boolean(),
    unpricedItems: z
      .int()
      .nonnegative()
      .describe('Placeholders with no estimate yet, so the total can be honest about itself.'),
  })
  .meta({ id: 'BudgetView' })

export const TransferGapView = z
  .object({
    afterItemId: z.uuid(),
    dayNumber: z.int().min(1),
    from: z.string(),
    to: z.string(),
  })
  .meta({
    id: 'TransferGapView',
    description:
      'Where the plan changes place with nothing connecting the two. Found by reading the ' +
      'itinerary rather than asked about upfront — nobody thinks "now I will plan transport".',
  })

export const JourneyView = z
  .object({
    id: z.uuid(),
    shareToken: z.string().describe('The read-only public link. Unguessable, never a password.'),
    title: z.string().nullable(),
    destinations: z.array(z.string()),
    durationDays: z.int().min(1),
    dateBucket: z.enum(DateBucket),
    startDate: z.string().nullable().describe('`YYYY-MM-DD`, when real dates were given.'),
    endDate: z.string().nullable(),
    partyAdults: z.int().min(1),
    partyChildren: z.int().min(0),
    partyType: z.string().nullable(),
    tripType: z.string().nullable(),
    interests: z.array(z.string()),
    budgetMinBdt: z.int().nonnegative().nullable(),
    budgetMaxBdt: z.int().nonnegative().nullable(),
    budgetScope: z.enum(BudgetScope),
    status: z.enum(JourneyStatus),
    quoteId: z.uuid().nullable(),
    /**
     * The most recent AI turn that changed anything, or null.
     *
     * Only useful next to the items: an item is part of that turn exactly when
     * the two ids match. Sent as an id rather than as a list of item ids because
     * the pairing then cannot go stale — a client holding a list would keep
     * highlighting an item the next turn moved.
     */
    lastChangeSetId: z.uuid().nullable(),
    /**
     * One entry per day that has anything to say about itself.
     *
     * SPARSE, NOT ONE PER DAY OF THE TRIP. A blank plan has no rows at all, and
     * a day nobody has drafted or annotated has none either — so the client
     * renders `durationDays` days and looks each one up rather than trusting the
     * array's length.
     */
    days: z.array(JourneyDayView),
    items: z.array(JourneyItemView),
    briefs: z.array(PreferenceBriefView),
    validation: ValidationView,
    budget: BudgetView,
    transferGaps: z.array(TransferGapView),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'JourneyView' })

export type JourneyView = z.infer<typeof JourneyView>

export const JourneySummaryView = z
  .object({
    id: z.uuid(),
    title: z.string().nullable(),
    destinations: z.array(z.string()),
    durationDays: z.int().min(1),
    status: z.enum(JourneyStatus),
    startDate: z.string().nullable(),
    itemCount: z.int().nonnegative(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'JourneySummaryView' })

export const JourneyListResponse = z
  .object({ journeys: z.array(JourneySummaryView) })
  .meta({ id: 'JourneyListResponse' })

// ─────────────────────────────────────────────────────────────────────────────
// Intake
// ─────────────────────────────────────────────────────────────────────────────

export const ChipView = z.object({ label: z.string(), value: z.string() }).meta({ id: 'ChipView' })

export const MissingFieldView = z
  .object({
    field: z.enum(['destinations', 'durationDays', 'dates', 'party', 'budget']),
    question: z.string(),
    chips: z.array(ChipView),
  })
  .meta({ id: 'MissingFieldView' })

export const ParseIntakeBody = z
  .object({
    text: z
      .string()
      .trim()
      .min(3)
      .max(1000)
      .describe('One sentence describing the trip, as the traveller typed it.'),
  })
  .meta({ id: 'ParseIntakeBody' })

export const ParsedIntakeView = z
  .object({
    destinations: z.array(z.string()),
    durationDays: z.int().nullable(),
    dateBucket: z.enum(DateBucket).nullable(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    partyAdults: z.int().nullable(),
    partyChildren: z.int().nullable(),
    partyType: z.string().nullable(),
    tripType: z.string().nullable(),
    interests: z.array(z.string()),
    budgetMinBdt: z.int().nullable(),
    budgetMaxBdt: z.int().nullable(),
    budgetScope: z.enum(BudgetScope).nullable(),
    missing: z.array(MissingFieldView),
  })
  .meta({
    id: 'ParsedIntakeView',
    description:
      'Null means the traveller did not say, never that we guessed. The chips a client renders ' +
      'from this are meant to be a mirror, and a mirror that flatters is worse than none.',
  })

export const CreateJourneyBody = z
  .object({ text: z.string().trim().min(3).max(1000) })
  .meta({ id: 'CreateJourneyBody' })

// ─────────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────────

export const UpdateBasicsBody = z
  .object({
    durationDays: z.int().min(1).max(60).optional(),
    partyAdults: z.int().min(1).max(40).optional(),
    partyChildren: z.int().min(0).max(40).optional(),
    budgetMinBdt: z.int().nonnegative().nullable().optional(),
    budgetMaxBdt: z.int().nonnegative().nullable().optional(),
    destinations: z.array(z.string().trim().min(1).max(80)).max(6).optional(),
    interests: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
  })
  .meta({ id: 'UpdateBasicsBody' })

export const AddItemBody = z
  .object({
    dayNumber: z.int().min(1).max(60),
    slot: z.enum(DaySlot),
    type: z.enum(JourneyItemType),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullable().optional(),
    /**
     * Where this came from. A VIATOR or GOOGLE_PLACES item must name an external
     * id; a CURATED one must name a catalogue activity. A CHECK constraint
     * refuses anything else, because an item claiming to be curated with nothing
     * behind it is the shape of a hallucination reaching a quotation.
     */
    source: z.enum(ItemSource),
    externalId: z.string().trim().max(80).nullable().optional(),
    activityId: z.uuid().nullable().optional(),
    startMinute: z.int().min(0).max(1439).nullable().optional(),
    durationMin: z.int().min(15).max(1440).nullable().optional(),
    locationName: z.string().trim().max(80).nullable().optional(),
    briefId: z.uuid().nullable().optional(),
  })
  .meta({
    id: 'AddItemBody',
    description:
      'No price is accepted. An estimate is read from the provider snapshot server-side, so a ' +
      'browser cannot decide what something costs.',
  })

export const MoveItemBody = z
  .object({ dayNumber: z.int().min(1).max(60), slot: z.enum(DaySlot) })
  .meta({ id: 'MoveItemBody' })

export const UpdateItemTimeBody = z
  .object({
    startMinute: z.int().min(0).max(1439).nullable(),
    durationMin: z.int().min(15).max(1440).nullable(),
  })
  .meta({ id: 'UpdateItemTimeBody' })

export const RefineBriefBody = z
  .object({
    pillar: z.enum(BriefPillar),
    location: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(600),
  })
  .meta({ id: 'RefineBriefBody' })

export const RefineBriefResponse = z
  .object({ brief: PreferenceBriefView, refinementChips: z.array(z.string()) })
  .meta({ id: 'RefineBriefResponse' })

export const RequestJourneyQuoteBody = z
  .object({
    whatsapp: z
      .string()
      .trim()
      .min(6)
      .max(30)
      .describe('WhatsApp first — it outperforms email heavily in this market.'),
    email: z.email().nullable().optional(),
    preferredTime: z.string().trim().max(60).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .meta({ id: 'RequestJourneyQuoteBody' })

export const JourneyChatBody = z
  .object({
    message: z.string().trim().min(1).max(1000),
    /**
     * The days the traveller has selected, if any.
     *
     * THE PRONOUN PROBLEM, SOLVED BY THE INTERFACE RATHER THAN BY THE MODEL.
     * "Give this day to Universal Studios" is unanswerable from text alone —
     * *which* day? Selecting day 2 and typing that sentence makes it obvious,
     * and it is obvious to the model too, because the days arrive as data rather
     * than as something to infer.
     *
     * Empty means the whole trip, which is the right default: somebody who
     * selected nothing is talking about the plan.
     */
    dayNumbers: z.array(z.int().min(1).max(60)).max(14).default([]),
  })
  .meta({ id: 'JourneyChatBody' })

export const SetDayNoteBody = z
  .object({
    note: z
      .string()
      .max(2000)
      .nullable()
      .transform((value) => (value === null || value.trim() === '' ? null : value.trim())),
  })
  .meta({
    id: 'SetDayNoteBody',
    description:
      "The traveller's own note on a day. Cleared by sending null or an empty string. Nothing " +
      'we generate ever writes this column.',
  })

export const JourneyChatResponse = z
  .object({
    reply: z.string().describe('At most two sentences. The itinerary is the answer.'),
    quickReplies: z.array(z.string()),
    pacing: z
      .object({
        dayNumber: z.int().min(1),
        message: z.string(),
        suggestedFix: z.string().nullable(),
      })
      .nullable(),
    journey: JourneyView,
  })
  .meta({ id: 'JourneyChatResponse' })

// ─────────────────────────────────────────────────────────────────────────────
// Suggestions
// ─────────────────────────────────────────────────────────────────────────────

export const SuggestionView = z
  .object({
    /** Provider id — a Viator product code or a Google place id. */
    externalId: z.string(),
    source: z.enum(ItemSource),
    title: z.string(),
    description: z.string().nullable(),
    imageUrl: z.string().nullable(),
    rating: z.number().nullable(),
    reviewCount: z.int().nullable(),
    durationMinMinutes: z.int().nullable(),
    durationMaxMinutes: z.int().nullable(),
    estimate: EstimateView,
    matchReason: z.string().nullable(),
    /** Phrases inside `matchReason` taken from the brief, for highlighting. */
    echoedPhrases: z.array(z.string()),
    /** The affiliate deep link. Shown on every Viator card, per the agreement. */
    externalUrl: z.string().nullable(),
    locationName: z.string().nullable(),
  })
  .meta({ id: 'SuggestionView' })

export const SuggestionsResponse = z
  .object({
    suggestions: z.array(SuggestionView).max(6),
    constraintWorthRelaxing: z
      .string()
      .nullable()
      .describe('Named only when fewer than three fit, so a dead end becomes a next step.'),
    /** Set when the pillar has no provider configured on this server. */
    unavailable: z.string().nullable(),
  })
  .meta({ id: 'SuggestionsResponse' })

export const ElicitorResponse = z
  .object({
    question: z
      .object({
        question: z.string(),
        chips: z.array(z.object({ label: z.string(), dimension: z.string(), value: z.string() })),
      })
      .nullable(),
    reason: z.string().nullable(),
  })
  .meta({
    id: 'ElicitorResponse',
    description:
      'Every chip describes something present in the real product data. An invented option would ' +
      'lead a traveller to state a preference for inventory nobody sells.',
  })

export const TransferOptionsResponse = z
  .object({
    options: z.array(
      z.object({
        mode: z.string(),
        durationMinMinutes: z.int(),
        durationMaxMinutes: z.int(),
        priceMinBdt: z.int(),
        priceMaxBdt: z.int(),
        pricePer: z.string(),
        confidence: z.enum(['high', 'low']),
        note: z.string().nullable(),
      })
    ),
  })
  .meta({
    id: 'TransferOptionsResponse',
    description:
      'High confidence means the agency has sold this route and knows the price. Low means the ' +
      'model estimated it. The distinction is shown to the traveller, so it has to mean something.',
  })

export const QuotedLineView = z
  .object({
    id: z.string(),
    journeyItemId: z.string().nullable(),
    vendorName: z.string().nullable(),
    label: z.string(),
    detail: z.string().nullable(),
    priceBdt: z.int(),
    quantity: z.int(),
  })
  .meta({
    id: 'QuotedLineView',
    description:
      'One priced line. `vendorName` is the thing the traveller could not know: their plan said ' +
      '"beachfront hotel near the centre" and this says which hotel. `priceBdt` is a real price ' +
      'for the whole party rather than a band, because the band was theirs and this is ours.',
  })

export const QuotedRevisionView = z
  .object({
    id: z.string(),
    version: z.int(),
    subtotalBdt: z.int(),
    discountBdt: z.int(),
    totalBdt: z.int(),
    inclusions: z.array(z.string()),
    exclusions: z.array(z.string()),
    terms: z.string().nullable(),
    travellerMessage: z.string().nullable(),
    validUntil: z.string().nullable(),
    sentAt: z.string().nullable(),
  })
  .meta({ id: 'QuotedRevisionView' })

export const ComparisonRowView = z
  .object({
    item: JourneyItemView,
    /** Null where we are not quoting for this — an absence, deliberately shown. */
    quoted: QuotedLineView.nullable(),
  })
  .meta({ id: 'ComparisonRowView' })

export const JourneyComparisonView = z
  .object({
    journeyId: z.string(),
    title: z.string().nullable(),
    destinations: z.array(z.string()),
    durationDays: z.int(),
    startDate: z.string().nullable(),
    partySize: z.int(),
    status: z.enum(JourneyStatus),
    quoteId: z.string().nullable(),
    quoteStatus: z.string().nullable(),
    revision: QuotedRevisionView.nullable(),
    rows: z.array(ComparisonRowView),
    extras: z.array(QuotedLineView),
    /** Both ends of the traveller's own estimates, for the honest side-by-side. */
    estimatedMinBdt: z.int(),
    estimatedMaxBdt: z.int(),
  })
  .meta({
    id: 'JourneyComparisonView',
    description:
      'What they planned beside what it costs.\n\n' +
      'THE PLAN IS THE SPINE AND THE QUOTE HANGS OFF IT. Every planned item appears as a row ' +
      'whether or not it was priced, so a line ops decided not to quote for shows as an absence ' +
      'rather than by simply not being there — the difference between noticing now and noticing ' +
      'at the airport. Lines with no `journeyItemId` are collected in `extras`, because "things ' +
      'we added" is a different question from "what you asked for, priced".\n\n' +
      'Only sent revisions ever appear here. A draft is a number nobody has agreed to stand ' +
      'behind, and a traveller shown one would quite reasonably hold us to it.',
  })

// ─────────────────────────────────────────────────────────────────────────────
// Projections
// ─────────────────────────────────────────────────────────────────────────────

interface ItemRow {
  id: string
  dayNumber: number
  slot: DaySlot
  startMinute: number | null
  durationMin: number | null
  type: JourneyItemType
  origin: ItemOrigin
  source: ItemSource
  externalId: string | null
  activityId: string | null
  title: string
  description: string | null
  estPriceMinBdt: number | null
  estPriceMaxBdt: number | null
  estPricePer: string | null
  matchReason: string | null
  locationName: string | null
  latitude: unknown
  longitude: unknown
  snapshot: unknown
  briefId: string | null
  changeSetId: string | null
}

/** Prisma hands Decimal back as an object; the wire wants a number or null. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * A `@db.Date` as the calendar date it is.
 *
 * Postgres hands these back at UTC midnight, so slicing the ISO string is
 * correct where a local formatter would render the previous day for every zone
 * west of UTC.
 */
function toDateString(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10)
}

export function toItemView(row: ItemRow): z.infer<typeof JourneyItemView> {
  return {
    id: row.id,
    dayNumber: row.dayNumber,
    slot: row.slot,
    startMinute: row.startMinute,
    durationMin: row.durationMin,
    type: row.type,
    origin: row.origin,
    source: row.source,
    externalId: row.externalId,
    activityId: row.activityId,
    title: row.title,
    description: row.description,
    estimate: { minBdt: row.estPriceMinBdt, maxBdt: row.estPriceMaxBdt, per: row.estPricePer },
    matchReason: row.matchReason,
    locationName: row.locationName,
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    snapshot: row.snapshot ?? null,
    briefId: row.briefId,
    changeSetId: row.changeSetId,
  }
}

export interface JourneyProjectionInput {
  id: string
  shareToken: string
  title: string | null
  destinations: string[]
  durationDays: number
  dateBucket: DateBucket
  startDate: Date | null
  endDate: Date | null
  partyAdults: number
  partyChildren: number
  partyType: string | null
  tripType: string | null
  interests: string[]
  budgetMinBdt: number | null
  budgetMaxBdt: number | null
  budgetScope: BudgetScope
  status: JourneyStatus
  quoteId: string | null
  lastChangeSetId: string | null
  updatedAt: Date
  days: {
    dayNumber: number
    locationName: string | null
    title: string | null
    summary: string | null
    note: string | null
  }[]
  items: ItemRow[]
  briefs: {
    id: string
    pillar: BriefPillar
    location: string
    nights: number | null
    constraints: unknown
    summary: string
  }[]
}

export function toJourneyView(
  row: JourneyProjectionInput,
  extras: {
    validation: z.infer<typeof ValidationView>
    budget: z.infer<typeof BudgetView>
    transferGaps: z.infer<typeof TransferGapView>[]
  }
): JourneyView {
  return {
    id: row.id,
    shareToken: row.shareToken,
    title: row.title,
    destinations: row.destinations,
    durationDays: row.durationDays,
    dateBucket: row.dateBucket,
    startDate: toDateString(row.startDate),
    endDate: toDateString(row.endDate),
    partyAdults: row.partyAdults,
    partyChildren: row.partyChildren,
    partyType: row.partyType,
    tripType: row.tripType,
    interests: row.interests,
    budgetMinBdt: row.budgetMinBdt,
    budgetMaxBdt: row.budgetMaxBdt,
    budgetScope: row.budgetScope,
    status: row.status,
    quoteId: row.quoteId,
    lastChangeSetId: row.lastChangeSetId,
    days: row.days.map((day) => ({
      dayNumber: day.dayNumber,
      locationName: day.locationName,
      title: day.title,
      summary: day.summary,
      note: day.note,
    })),
    items: row.items.map(toItemView),
    briefs: row.briefs.map((brief) => ({
      id: brief.id,
      pillar: brief.pillar,
      location: brief.location,
      nights: brief.nights,
      constraints: brief.constraints ?? null,
      summary: brief.summary,
    })),
    validation: extras.validation,
    budget: extras.budget,
    transferGaps: extras.transferGaps,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * The comparison, as the traveller's screen wants it.
 *
 * `toItemView` is reused rather than reimplemented, so an item on this screen is
 * the same object it is in the workspace — one projection, one set of
 * components, and no chance of the two drifting into disagreement about what an
 * estimate means.
 */
export function toComparisonView(
  input: {
    journey: {
      id: string
      title: string | null
      destinations: string[]
      durationDays: number
      startDate: Date | null
      partyAdults: number
      partyChildren: number
      partySize: number
      budgetMinBdt: number | null
      budgetMaxBdt: number | null
      status: JourneyStatus
    }
    quote: { id: string; status: string } | null
    revision: {
      id: string
      version: number
      subtotalBdt: number
      discountBdt: number
      totalBdt: number
      inclusions: string[]
      exclusions: string[]
      terms: string | null
      travellerMessage: string | null
      validUntil: Date | null
      sentAt: Date | null
    } | null
    rows: { item: ItemRow; quoted: QuotedLineRow | null }[]
    extras: QuotedLineRow[]
  },
  estimate: { estimatedMinBdt: number; estimatedMaxBdt: number }
): z.infer<typeof JourneyComparisonView> {
  return {
    journeyId: input.journey.id,
    title: input.journey.title,
    destinations: input.journey.destinations,
    durationDays: input.journey.durationDays,
    startDate: toDateString(input.journey.startDate),
    partySize: input.journey.partySize,
    status: input.journey.status,
    quoteId: input.quote?.id ?? null,
    quoteStatus: input.quote?.status ?? null,
    revision:
      input.revision === null
        ? null
        : {
            ...input.revision,
            // Timestamps rather than calendar dates, so these are full ISO
            // strings — the client decides how to say "held until Thursday".
            validUntil: input.revision.validUntil?.toISOString() ?? null,
            sentAt: input.revision.sentAt?.toISOString() ?? null,
          },
    rows: input.rows.map((row) => ({
      item: toItemView(row.item),
      quoted: row.quoted === null ? null : toLineView(row.quoted),
    })),
    extras: input.extras.map(toLineView),
    estimatedMinBdt: estimate.estimatedMinBdt,
    estimatedMaxBdt: estimate.estimatedMaxBdt,
  }
}

interface QuotedLineRow {
  id: string
  journeyItemId: string | null
  vendorName: string | null
  label: string
  detail: string | null
  priceBdt: number
  quantity: number
}

function toLineView(row: QuotedLineRow): z.infer<typeof QuotedLineView> {
  return {
    id: row.id,
    journeyItemId: row.journeyItemId,
    vendorName: row.vendorName,
    label: row.label,
    detail: row.detail,
    priceBdt: row.priceBdt,
    quantity: row.quantity,
  }
}
