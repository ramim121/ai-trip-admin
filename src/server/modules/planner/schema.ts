import { z } from 'zod'
import {
  ItineraryBlockKind,
  ItineraryStatus,
  PlannerMessageRole,
  PlannerSessionStatus,
  TransitMode,
} from '@/generated/prisma/enums'
import {
  BUDGET_BANDS,
  MAX_PARTY_SIZE,
  MAX_TRIP_DAYS,
  MINUTES_IN_DAY,
  TRANSPORT_PREFERENCES,
  TRIP_PACES,
  TRIP_PURPOSES,
} from '@/server/ai/schemas'
import { EntitlementRefusal } from '@/server/modules/entitlements/schema'
import { CONFLICT_CODES } from './conflicts'

/**
 * The wire contract for the planner and for itineraries.
 *
 * Request and response shapes live together deliberately. The response schemas
 * are the definition of what leaves this process, so anything absent from them —
 * the owning user id, a cost price, a supplier margin — has to be a deliberate
 * addition rather than something that leaked in because a `select` grew a
 * column.
 *
 * Every schema carries `.meta({ id })` so the generator emits it as a named
 * component and beyond-borders-web's codegen gets a real type instead of an
 * anonymous inline shape.
 *
 * Where a concept's input and output differ they get *different* ids —
 * `TripBriefInput` versus `TripBrief` — because one id resolving to two JSON
 * Schemas is exactly the collision `document.ts` refuses to publish.
 */

// ── Shared field types ──────────────────────────────────────────────────────

/** Minutes from local midnight. A block starts within the day it belongs to. */
const StartMinute = z
  .int()
  .min(0)
  .max(MINUTES_IN_DAY - 1)
  .describe('Minutes from local midnight, 0–1439. 540 is 09:00.')

/** May exceed 1440 so a block can run past midnight; 1560 is 02:00 the next day. */
const EndMinute = z
  .int()
  .min(1)
  .max(MINUTES_IN_DAY * 2)
  .describe('Minutes from the same local midnight. Above 1440 runs into the next morning.')

const DayNumber = z.int().min(1).max(MAX_TRIP_DAYS).describe('1-based. Day 1 is the first day.')

// ── Trip brief ──────────────────────────────────────────────────────────────

/**
 * What a client may send about the trip.
 *
 * Every field optional, because the brief accumulates across a conversation.
 * Sending a field overwrites it; omitting it changes nothing. There is
 * deliberately no way to express "clear this": a client that forgets a field
 * must not be able to erase what the traveller said three turns ago.
 */
export const TripBriefInput = z
  .object({
    destination: z.string().trim().min(1).max(120).optional(),
    destinationId: z.uuid().optional(),
    totalDays: z.int().min(1).max(MAX_TRIP_DAYS).optional(),
    startDate: z.iso.date().optional().describe('Calendar date, YYYY-MM-DD.'),
    partySize: z.int().min(1).max(MAX_PARTY_SIZE).optional(),
    purpose: z.enum(TRIP_PURPOSES).optional(),
    pace: z.enum(TRIP_PACES).optional(),
    transportPreference: z.enum(TRANSPORT_PREFERENCES).optional(),
    budgetBand: z.enum(BUDGET_BANDS).optional(),
    interests: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    notes: z
      .string()
      .trim()
      .max(600)
      .optional()
      .describe('Anything they wanted to say in their own words. Distinct from mobilityNotes.'),
    mobilityNotes: z.string().trim().max(500).optional(),
    mustSee: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    avoid: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
  })
  .meta({
    id: 'TripBriefInput',
    description:
      'Facts about the trip. Sending a field overwrites it; omitting one leaves it untouched.',
  })
export type TripBriefInput = z.infer<typeof TripBriefInput>

/** The brief as stored. Lists are always present, possibly empty. */
export const TripBrief = TripBriefInput.extend({
  interests: z.array(z.string()),
  mustSee: z.array(z.string()),
  avoid: z.array(z.string()),
}).meta({ id: 'TripBrief', description: 'Everything known about the trip so far.' })
export type TripBrief = z.infer<typeof TripBrief>

// ── Planner sessions ────────────────────────────────────────────────────────

export const CreatePlannerSessionBody = z
  .object({
    brief: TripBriefInput.optional(),
    /**
     * Resuming is the default: a traveller who reloads the page has not started
     * a second trip. Passing false is how a client offers "plan another".
     */
    resume: z.boolean().optional(),
  })
  .meta({ id: 'CreatePlannerSessionBody' })
export type CreatePlannerSessionBody = z.infer<typeof CreatePlannerSessionBody>

export const PlannerMessage = z
  .object({
    id: z.uuid(),
    role: z.enum(PlannerMessageRole),
    content: z.string(),
    /** `provider/model-id`, e.g. `google/gemini-2.5-flash`. Null on traveller turns. */
    model: z.string().nullable(),
    promptTokens: z.int().nullable(),
    completionTokens: z.int().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'PlannerMessage' })
export type PlannerMessage = z.infer<typeof PlannerMessage>

export const PlannerSession = z
  .object({
    id: z.uuid(),
    status: z.enum(PlannerSessionStatus),
    tripBrief: TripBrief,
    createdAt: z.iso.datetime(),
    lastMessageAt: z.iso.datetime(),
    itineraryId: z.uuid().nullable().describe(
      "The most recent itinerary built in this session, or null. The planner reads this on mount to resume the trip rather than starting a second one."
    ),
    /** False when this call created the session, true when it picked one up. */
    resumed: z.boolean(),
    messages: z.array(PlannerMessage),
  })
  .meta({ id: 'PlannerSession' })
export type PlannerSession = z.infer<typeof PlannerSession>

export const PlannerMessageBody = z
  .object({ text: z.string().trim().min(1).max(4000) })
  .meta({ id: 'PlannerMessageBody' })
export type PlannerMessageBody = z.infer<typeof PlannerMessageBody>

/**
 * One frame of the streaming reply.
 *
 * The response to POST …/messages is `text/event-stream`, and each `data:` line
 * carries one of these encoded as JSON. Discriminated on `type` so a client can
 * switch exhaustively; an unknown type must be ignored rather than treated as an
 * error, which is what lets a frame be added without a version bump.
 */
export const PlannerStreamEvent = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('start'),
      sessionId: z.uuid(),
      userMessageId: z.uuid(),
      model: z.string(),
    }),
    z.object({ type: z.literal('delta'), text: z.string() }),
    z.object({ type: z.literal('tool'), name: z.string() }),
    z.object({ type: z.literal('brief'), brief: TripBrief }),
    z.object({ type: z.literal('limit'), reason: z.string(), message: z.string() }),
    z.object({
      type: z.literal('done'),
      messageId: z.uuid(),
      model: z.string(),
      promptTokens: z.int(),
      completionTokens: z.int(),
      brief: TripBrief,
    }),
    z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  ])
  .meta({
    id: 'PlannerStreamEvent',
    description:
      'One Server-Sent Events frame. `delta` carries prose to append; `tool` names a catalog ' +
      'lookup in progress; `limit` is a plan wall reached mid-answer rather than a failure; ' +
      '`done` is always last unless the connection dropped.',
  })
export type PlannerStreamEvent = z.infer<typeof PlannerStreamEvent>

// ── Conflicts ───────────────────────────────────────────────────────────────

export const TimelineConflict = z
  .object({
    code: z.enum(CONFLICT_CODES),
    severity: z.enum(['HARD', 'WARNING']),
    dayNumber: DayNumber,
    blockIds: z.array(z.uuid()),
    minutes: z
      .int()
      .describe('Minutes of overlap, or of travel shortfall. Zero when the code carries no size.'),
    message: z.string().describe('Safe to show a traveller. Wording is not part of the contract.'),
  })
  .meta({
    id: 'TimelineConflict',
    description:
      'Something wrong with the day, reported rather than fixed. HARD means the day cannot be ' +
      'walked as written; WARNING means it can, but probably is not what they meant. Nothing is ' +
      'ever silently reordered to resolve one.',
  })
export type TimelineConflict = z.infer<typeof TimelineConflict>

// ── Itineraries ─────────────────────────────────────────────────────────────

export const ItineraryBlock = z
  .object({
    id: z.uuid(),
    dayNumber: DayNumber,
    kind: z.enum(ItineraryBlockKind),
    activityId: z.uuid().nullable().describe('Always set for ACTIVITY, always null otherwise.'),
    title: z.string(),
    description: z.string().nullable(),
    startMinute: StartMinute,
    endMinute: EndMinute,
    transitMode: z.enum(TransitMode).nullable(),
    transitFromBlockId: z.uuid().nullable(),
    isLocked: z.boolean().describe('Pinned by the traveller. Regeneration plans around it.'),
    isEstimate: z
      .boolean()
      .describe(
        'True for a transfer computed from distance rather than routed. We may redraw our own ' +
          'estimates freely; a block a person authored is never touched.'
      ),
    sortOrder: z.int(),
    costBdt: z
      .int()
      .nullable()
      .describe(
        'Whole taka for the whole block, party size included. Null when nothing is charged.'
      ),
  })
  .meta({ id: 'ItineraryBlock' })
export type ItineraryBlock = z.infer<typeof ItineraryBlock>

export const ItineraryDay = z
  .object({
    id: z.uuid(),
    dayNumber: DayNumber,
    date: z.iso.date().nullable(),
    title: z.string().nullable(),
    notes: z.string().nullable(),
    blocks: z.array(ItineraryBlock),
  })
  .meta({ id: 'ItineraryDay' })
export type ItineraryDay = z.infer<typeof ItineraryDay>

export const Itinerary = z
  .object({
    id: z.uuid(),
    plannerSessionId: z.uuid().nullable(),
    title: z.string(),
    destinationId: z.uuid().nullable(),
    destinationLabel: z
      .string()
      .describe('What the traveller called the place. Kept even when destinationId is null.'),
    startDate: z.iso.date().nullable(),
    endDate: z.iso.date().nullable(),
    totalDays: z.int().describe('The length of trip they asked for.'),
    plannedDays: z
      .int()
      .describe('How many days actually carry a plan. Below totalDays means a plan wall was hit.'),
    partySize: z.int(),
    purpose: z.enum(TRIP_PURPOSES),
    pace: z.enum(TRIP_PACES),
    transportPreference: z.enum(TRANSPORT_PREFERENCES),
    budgetBand: z.enum(BUDGET_BANDS).nullable(),
    status: z.enum(ItineraryStatus),
    coverImageUrl: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    days: z.array(ItineraryDay),
    conflicts: z.array(TimelineConflict),
    estimatedTotalBdt: z.int().describe('Sum of every block cost, in whole taka.'),
  })
  .meta({ id: 'Itinerary' })
export type Itinerary = z.infer<typeof Itinerary>

export const ItinerarySummary = z
  .object({
    id: z.uuid(),
    title: z.string(),
    destinationLabel: z.string(),
    startDate: z.iso.date().nullable(),
    totalDays: z.int(),
    partySize: z.int(),
    status: z.enum(ItineraryStatus),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ItinerarySummary' })
export type ItinerarySummary = z.infer<typeof ItinerarySummary>

export const ItineraryListResponse = z
  .object({
    items: z.array(ItinerarySummary),
    total: z.int().describe('Matching itineraries in total, ignoring limit and offset.'),
  })
  .meta({ id: 'ItineraryListResponse' })
export type ItineraryListResponse = z.infer<typeof ItineraryListResponse>

/** Query parameters are strings on the wire, so numbers are coerced here. */
export const ItineraryListQuery = z.object({
  status: z.enum(ItineraryStatus).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})
export type ItineraryListQuery = z.infer<typeof ItineraryListQuery>

// ── Day allowance ───────────────────────────────────────────────────────────

/**
 * How much of the trip this traveller may have planned, and why.
 *
 * Returned on a 200 rather than raised as a 403, because the ordinary outcome is
 * a partial success: a FREE traveller asking for seven days gets two good days
 * and a `refusal` explaining the rest. The refusal arrives *with* the plan, not
 * instead of it.
 */
export const DayAllowance = z
  .object({
    maxDays: z.int().describe('Days of detail allowed right now.'),
    unlimited: z.boolean(),
    unlocked: z.boolean().describe('True when the one-off unlock has been bought for this trip.'),
    source: z.enum(['ANONYMOUS', 'UNLOCK', 'SUBSCRIPTION', 'PLAN']),
    refusal: EntitlementRefusal.nullable(),
  })
  .meta({ id: 'DayAllowance' })
export type DayAllowance = z.infer<typeof DayAllowance>

export const MaterialiseItineraryBody = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    days: z
      .int()
      .min(1)
      .max(MAX_TRIP_DAYS)
      .optional()
      .describe('Days wanted. Clamped by the entitlement; defaults to the brief.'),
  })
  .meta({ id: 'MaterialiseItineraryBody' })
export type MaterialiseItineraryBody = z.infer<typeof MaterialiseItineraryBody>

export const MaterialiseItineraryResponse = z
  .object({
    itinerary: Itinerary,
    allowance: DayAllowance,
    requestedDays: z.int(),
    generatedDays: z.int().describe('Below requestedDays means the allowance bound; see refusal.'),
  })
  .meta({ id: 'MaterialiseItineraryResponse' })
export type MaterialiseItineraryResponse = z.infer<typeof MaterialiseItineraryResponse>

export const RegenerateDayResponse = z
  .object({ itinerary: Itinerary, allowance: DayAllowance, dayNumber: DayNumber })
  .meta({ id: 'RegenerateDayResponse' })
export type RegenerateDayResponse = z.infer<typeof RegenerateDayResponse>

export const ExtendItineraryResponse = z
  .object({
    itinerary: Itinerary,
    allowance: DayAllowance,
    addedDays: z
      .array(DayNumber)
      .describe('Day numbers this call planned. Empty when there was nothing to add.'),
    unreachableDays: z
      .array(DayNumber)
      .describe(
        'Days inside the trip the entitlement will not stretch to. An empty `addedDays` ' +
          'alongside a populated `unreachableDays` means a wall was hit, NOT that the trip is ' +
          'complete — the two are indistinguishable without this field, and telling a traveller ' +
          '"all done" while four days are missing is the failure it exists to prevent.'
      ),
  })
  .meta({ id: 'ExtendItineraryResponse' })
export type ExtendItineraryResponse = z.infer<typeof ExtendItineraryResponse>

// ── Itinerary edits ─────────────────────────────────────────────────────────

export const UpdateItineraryBody = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    startDate: z.iso
      .date()
      .nullable()
      .optional()
      .describe('Re-dates every day, which changes which opening-hours warnings apply.'),
    partySize: z.int().min(1).max(MAX_PARTY_SIZE).optional(),
    purpose: z.enum(TRIP_PURPOSES).optional(),
    pace: z.enum(TRIP_PACES).optional(),
    transportPreference: z
      .enum(TRANSPORT_PREFERENCES)
      .optional()
      .describe('Re-estimates every transfer we drew. Transfers you authored are untouched.'),
    budgetBand: z.enum(BUDGET_BANDS).nullable().optional(),
    coverImageUrl: z.string().max(2000).nullable().optional(),
  })
  .meta({ id: 'UpdateItineraryBody' })
export type UpdateItineraryBody = z.infer<typeof UpdateItineraryBody>

export const CreateBlockBody = z
  .object({
    kind: z.enum(ItineraryBlockKind),
    activityId: z
      .uuid()
      .optional()
      .describe('Required for ACTIVITY and rejected on every other kind.'),
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    startMinute: StartMinute,
    endMinute: EndMinute,
    transitMode: z.enum(TransitMode).nullable().optional(),
    isLocked: z.boolean().optional(),
  })
  .meta({
    id: 'CreateBlockBody',
    description:
      'Cost is never accepted here — it is recomputed from the catalog price and the party size.',
  })
export type CreateBlockBody = z.infer<typeof CreateBlockBody>

export const UpdateBlockBody = z
  .object({
    startMinute: StartMinute.optional(),
    endMinute: EndMinute.optional(),
    dayNumber: DayNumber.optional().describe('Move the block to another day of the same trip.'),
    title: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    isLocked: z.boolean().optional(),
    transitMode: z.enum(TransitMode).nullable().optional(),
  })
  .meta({ id: 'UpdateBlockBody' })
export type UpdateBlockBody = z.infer<typeof UpdateBlockBody>

export const BlockMutationResponse = z.object({ itinerary: Itinerary, blockId: z.uuid() }).meta({
  id: 'BlockMutationResponse',
  description:
    'The whole itinerary comes back, conflicts included: one edit can create a clash on a day ' +
    'the client was not looking at, and a partial response would hide it.',
})
export type BlockMutationResponse = z.infer<typeof BlockMutationResponse>

export const SaveItineraryResponse = z
  .object({
    itinerary: Itinerary,
    remaining: z
      .int()
      .nullable()
      .describe('Saved-itinerary allowance left afterwards. Null on an uncapped plan.'),
  })
  .meta({ id: 'SaveItineraryResponse' })
export type SaveItineraryResponse = z.infer<typeof SaveItineraryResponse>
