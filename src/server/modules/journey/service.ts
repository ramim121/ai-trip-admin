import { randomBytes } from 'node:crypto'
import {
  BriefPillar,
  DaySlot,
  ItemOrigin,
  ItemSource,
  JourneyItemType,
  JourneyStatus,
  QuoteStatus,
} from '@/generated/prisma/enums'
import type { Prisma } from '@/generated/prisma/client'
import { db } from '@/lib/db'
import { badRequest, conflict, notFound } from '@/server/http/errors'
import { curateBrief, draftSkeleton, estimateTransfer } from './ai'
import type { ParsedTrip } from './ai-schema'
import { validate, type ConflictInput } from './conflicts'

/**
 * A journey, from a typed sentence to a quotation request.
 *
 * WHAT THIS MODULE OWNS is the trip and everything hanging off it. What it
 * deliberately does not own is pricing: a quotation goes through the existing
 * Quote tables, which already carry revisions, the immutable-once-sent trigger,
 * the ops queue and the accept predicate. Reimplementing those here would give
 * the agency two pricing pipelines, and one of them would drift.
 */

const SHARE_TOKEN_BYTES = 18

/**
 * An unguessable public link.
 *
 * Eighteen random bytes as base64url — 144 bits, comfortably past the twenty
 * characters the CHECK demands. THIS IS THE ONLY PROTECTION ON A SHARED PLAN,
 * because viewing one requires no account, so it has to be unguessable rather
 * than merely unlikely.
 */
function newShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString('base64url')
}

const JOURNEY_SELECT = {
  id: true,
  userId: true,
  shareToken: true,
  title: true,
  rawIntake: true,
  destinations: true,
  durationDays: true,
  dateBucket: true,
  startDate: true,
  endDate: true,
  partyAdults: true,
  partyChildren: true,
  partyType: true,
  tripType: true,
  interests: true,
  budgetMinBdt: true,
  budgetMaxBdt: true,
  budgetScope: true,
  status: true,
  quoteId: true,
  contactWhatsapp: true,
  contactEmail: true,
  contactPreferredTime: true,
  userNotes: true,
  createdAt: true,
  updatedAt: true,
  items: {
    orderBy: [{ dayNumber: 'asc' }, { slot: 'asc' }, { sortOrder: 'asc' }],
    select: {
      id: true,
      dayNumber: true,
      slot: true,
      startMinute: true,
      durationMin: true,
      type: true,
      origin: true,
      source: true,
      externalId: true,
      activityId: true,
      title: true,
      description: true,
      estPriceMinBdt: true,
      estPriceMaxBdt: true,
      estPricePer: true,
      matchReason: true,
      locationName: true,
      latitude: true,
      longitude: true,
      snapshot: true,
      briefId: true,
      sortOrder: true,
    },
  },
  briefs: {
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      pillar: true,
      location: true,
      nights: true,
      constraints: true,
      summary: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.JourneySelect

// ─────────────────────────────────────────────────────────────────────────────
// Creating and reading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Turn a parse into a real trip.
 *
 * `userId` IS OPTIONAL BECAUSE THE FUNNEL DEPENDS ON IT. A visitor types a
 * sentence, sees their trip understood, and only then meets the sign-in wall —
 * so the journey exists before the account does, and `claimJourney` attaches it
 * afterwards. Nothing is lost across the wall because nothing has to be
 * re-entered.
 *
 * Defaults where the parse found nothing are honest rather than clever: seven
 * days because that is what an unspecified holiday means to most people, two
 * adults because that is who plans a trip together. Both appear as editable
 * chips the moment the workspace opens.
 */
export async function createJourney(
  parsed: ParsedTrip,
  rawIntake: string | null,
  userId: string | null
): Promise<string> {
  const durationDays = parsed.durationDays ?? 7

  const journey = await db.journey.create({
    data: {
      userId,
      shareToken: newShareToken(),
      rawIntake,
      destinations: parsed.destinations,
      durationDays,
      dateBucket: parsed.dateBucket ?? 'CUSTOM',
      startDate: parsed.startDate === null ? null : new Date(parsed.startDate),
      endDate: parsed.endDate === null ? null : new Date(parsed.endDate),
      partyAdults: parsed.partyAdults ?? 2,
      partyChildren: parsed.partyChildren ?? 0,
      partyType: parsed.partyType,
      tripType: parsed.tripType,
      interests: parsed.interests,
      budgetMinBdt: parsed.budgetMinBdt,
      budgetMaxBdt: parsed.budgetMaxBdt,
      budgetScope: parsed.budgetScope ?? 'TOTAL_TRIP',
      title:
        parsed.destinations.length > 0
          ? `${parsed.destinations.join(' & ')} — ${durationDays} days`
          : null,
    },
    select: { id: true },
  })

  return journey.id
}

/**
 * Attach an unowned journey to the account that just signed in.
 *
 * Predicated on `userId: null`, so a link somebody pasted cannot be claimed out
 * from under its owner — the update matches nothing and the caller is told,
 * rather than silently reassigning a stranger's trip.
 */
export async function claimJourney(journeyId: string, userId: string): Promise<void> {
  const claimed = await db.journey.updateMany({
    where: { id: journeyId, userId: null },
    data: { userId },
  })

  if (claimed.count === 0) throw conflict('That plan already belongs to an account.')
}

/** One journey the caller owns. Ownership is a WHERE clause, as everywhere here. */
export async function readJourney(journeyId: string, userId: string) {
  const journey = await db.journey.findFirst({
    where: { id: journeyId, userId },
    select: JOURNEY_SELECT,
  })

  if (journey === null) throw notFound('That plan was not found.')
  return journey
}

/**
 * A journey by its share token, for somebody with no account.
 *
 * READ-ONLY BY CONSTRUCTION — no write path accepts a token. A co-traveller
 * opening a WhatsApp link sees the plan; editing requires signing in, at which
 * point they are a real user with a real id and every ordinary ownership check
 * applies.
 */
export async function readJourneyByToken(shareToken: string) {
  const journey = await db.journey.findUnique({ where: { shareToken }, select: JOURNEY_SELECT })

  if (journey === null) throw notFound('That link is not valid.')
  return journey
}

/** Every journey this traveller has, newest first. */
export async function listJourneys(userId: string, take = 50) {
  return db.journey.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take,
    select: {
      id: true,
      title: true,
      destinations: true,
      durationDays: true,
      status: true,
      startDate: true,
      updatedAt: true,
      _count: { select: { items: true } },
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The draft
// ─────────────────────────────────────────────────────────────────────────────

/** Pace from the trip's own shape, since a parse rarely states one outright. */
function paceFor(
  interests: readonly string[],
  tripType: string | null
): 'relaxed' | 'balanced' | 'packed' {
  const text = `${interests.join(' ')} ${tripType ?? ''}`.toLowerCase()

  if (/honeymoon|relax|beach|spa|lazy/.test(text)) return 'relaxed'
  if (/adventure|hiking|packed|explore/.test(text)) return 'packed'
  return 'balanced'
}

/**
 * Fill an empty journey with a draft.
 *
 * DRAFT-FIRST IS THE DEFAULT, because a blank canvas suits a power planner and
 * freezes everybody else. Every item is a placeholder carrying a search query,
 * so nothing here names a business — real options arrive when a traveller opens
 * a pillar and picks one.
 *
 * Refuses to run twice. A second skeleton over an edited plan would silently
 * discard the traveller's work, and regenerating a single day already exists for
 * somebody who wants a fresh start on part of it.
 */
export async function generateSkeleton(journeyId: string, userId: string) {
  const journey = await readJourney(journeyId, userId)

  if (journey.items.length > 0) {
    throw conflict('This plan already has a draft. Regenerate a single day instead.')
  }

  const skeleton = await draftSkeleton(
    {
      destinations: journey.destinations,
      durationDays: journey.durationDays,
      partyType: journey.partyType,
      tripType: journey.tripType,
      interests: journey.interests,
      pace: paceFor(journey.interests, journey.tripType),
    },
    { userId }
  )

  // Days past the end of the trip are dropped rather than rejected. The model is
  // told the length and occasionally overshoots by one; discarding a whole good
  // skeleton over its last line would be the wrong trade, and the trigger would
  // refuse the row anyway.
  const rows = skeleton.days
    .filter((day) => day.dayNumber <= journey.durationDays)
    .flatMap((day) =>
      day.items.map((item, index) => ({
        journeyId,
        dayNumber: day.dayNumber,
        slot: item.slot as DaySlot,
        type: item.type as JourneyItemType,
        origin: ItemOrigin.AI_SUGGESTED,
        source: ItemSource.AI_ESTIMATE,
        title: item.title,
        durationMin: item.durationMin,
        // The search query rides in the snapshot rather than in a column: it is
        // scaffolding for finding a real option and stops mattering the moment
        // one is picked.
        snapshot: { searchQuery: item.searchQuery, theme: day.theme } as never,
        sortOrder: index,
        // The day`s own place, so transfer gaps are found where the trip really
        // moves rather than everywhere an item happens to differ from city one.
        locationName: day.location,
      }))
    )

  if (rows.length > 0) await db.journeyItem.createMany({ data: rows })

  return readJourney(journeyId, userId)
}

// ─────────────────────────────────────────────────────────────────────────────
// Items
// ─────────────────────────────────────────────────────────────────────────────

export interface AddItemInput {
  dayNumber: number
  slot: DaySlot
  type: JourneyItemType
  title: string
  description?: string | null
  source: ItemSource
  externalId?: string | null
  activityId?: string | null
  startMinute?: number | null
  durationMin?: number | null
  estPriceMinBdt?: number | null
  estPriceMaxBdt?: number | null
  estPricePer?: string | null
  matchReason?: string | null
  locationName?: string | null
  latitude?: number | null
  longitude?: number | null
  snapshot?: unknown
  briefId?: string | null
  origin?: ItemOrigin
}

/**
 * Put something on a day.
 *
 * The day range is checked here as well as by the trigger, so a traveller gets a
 * sentence rather than a constraint violation. The trigger stays, because a
 * check somebody forgets to write is not a rule.
 */
export async function addItem(journeyId: string, userId: string, input: AddItemInput) {
  const journey = await readJourney(journeyId, userId)

  if (input.dayNumber < 1 || input.dayNumber > journey.durationDays) {
    throw badRequest(`This trip is ${journey.durationDays} days long.`)
  }

  const sameSlot = journey.items.filter(
    (item) => item.dayNumber === input.dayNumber && item.slot === input.slot
  )

  await db.journeyItem.create({
    data: {
      journeyId,
      dayNumber: input.dayNumber,
      slot: input.slot,
      type: input.type,
      // Anything a traveller adds deliberately is pinned. The admin has to tell
      // a requirement from a suggestion nobody objected to.
      origin: input.origin ?? ItemOrigin.USER_PINNED,
      source: input.source,
      externalId: input.externalId ?? null,
      activityId: input.activityId ?? null,
      title: input.title,
      description: input.description ?? null,
      startMinute: input.startMinute ?? null,
      durationMin: input.durationMin ?? null,
      estPriceMinBdt: input.estPriceMinBdt ?? null,
      estPriceMaxBdt: input.estPriceMaxBdt ?? null,
      estPricePer: input.estPricePer ?? null,
      matchReason: input.matchReason ?? null,
      locationName: input.locationName ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      snapshot: (input.snapshot ?? null) as never,
      briefId: input.briefId ?? null,
      sortOrder: sameSlot.length,
    },
    select: { id: true },
  })

  return readJourney(journeyId, userId)
}

export async function moveItem(
  journeyId: string,
  userId: string,
  itemId: string,
  dayNumber: number,
  slot: DaySlot
) {
  const journey = await readJourney(journeyId, userId)

  if (dayNumber < 1 || dayNumber > journey.durationDays) {
    throw badRequest(`This trip is ${journey.durationDays} days long.`)
  }

  // Scoped on the journey as well as the id, so an item id from somebody else's
  // plan moves nothing.
  const moved = await db.journeyItem.updateMany({
    where: { id: itemId, journeyId },
    data: { dayNumber, slot },
  })

  if (moved.count === 0) throw notFound('That item was not found.')

  return readJourney(journeyId, userId)
}

export async function updateItemTime(
  journeyId: string,
  userId: string,
  itemId: string,
  startMinute: number | null,
  durationMin: number | null
) {
  await readJourney(journeyId, userId)

  const updated = await db.journeyItem.updateMany({
    where: { id: itemId, journeyId },
    data: { startMinute, durationMin },
  })

  if (updated.count === 0) throw notFound('That item was not found.')

  return readJourney(journeyId, userId)
}

export async function removeItem(journeyId: string, userId: string, itemId: string) {
  await readJourney(journeyId, userId)

  const removed = await db.journeyItem.deleteMany({ where: { id: itemId, journeyId } })
  if (removed.count === 0) throw notFound('That item was not found.')

  return readJourney(journeyId, userId)
}

// ─────────────────────────────────────────────────────────────────────────────
// Preference briefs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge a message into the brief for one pillar in one place.
 *
 * History is appended rather than replaced, so how a constraint arrived stays
 * diagnosable — a brief saying "3-star minimum" that cannot show which sentence
 * produced it is impossible to argue with when the traveller says they never
 * asked for that.
 */
export async function refineBrief(
  journeyId: string,
  userId: string,
  pillar: BriefPillar,
  location: string,
  message: string
) {
  await readJourney(journeyId, userId)

  const place = location.trim()
  if (place === '') throw badRequest('Which place is this about?')

  const existing = await db.preferenceBrief.findUnique({
    where: { journeyId_pillar_location: { journeyId, pillar, location: place } },
    select: { constraints: true, history: true },
  })

  const curated = await curateBrief(
    {
      pillar,
      location: place,
      existing: existing?.constraints ?? {
        starMin: null,
        locationHints: [],
        budgetPerNightMinBdt: null,
        budgetPerNightMaxBdt: null,
        amenities: [],
        notes: [],
      },
      message,
    },
    { userId }
  )

  const priorHistory = Array.isArray(existing?.history) ? existing.history : []
  const history = [...priorHistory, { msg: message, ts: new Date().toISOString() }]

  const brief = await db.preferenceBrief.upsert({
    where: { journeyId_pillar_location: { journeyId, pillar, location: place } },
    create: {
      journeyId,
      pillar,
      location: place,
      constraints: curated.constraints as never,
      summary: curated.summary,
      history: history as never,
    },
    update: {
      constraints: curated.constraints as never,
      summary: curated.summary,
      history: history as never,
    },
    select: { id: true, pillar: true, location: true, constraints: true, summary: true },
  })

  return { brief, refinementChips: curated.refinementChips }
}

export async function readBrief(journeyId: string, pillar: BriefPillar, location: string) {
  return db.preferenceBrief.findUnique({
    where: { journeyId_pillar_location: { journeyId, pillar, location: location.trim() } },
    select: {
      id: true,
      pillar: true,
      location: true,
      nights: true,
      constraints: true,
      summary: true,
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Transfers
// ─────────────────────────────────────────────────────────────────────────────

export interface TransferGap {
  afterItemId: string
  dayNumber: number
  from: string
  to: string
}

/**
 * Where the plan changes place.
 *
 * TRANSFERS ARE CONNECTIVE TISSUE, NOT A PILLAR. Nobody thinks "now I will plan
 * transport"; they think "how do I get from here to there". So gaps are found by
 * reading the itinerary rather than asked about upfront, and a card appears
 * exactly where the plan created the need.
 *
 * Items with no location are skipped rather than treated as a move — a dinner
 * nobody has placed yet is not a journey to somewhere else.
 */
export function findTransferGaps(
  items: readonly {
    id: string
    dayNumber: number
    locationName: string | null
    type: JourneyItemType
  }[]
): TransferGap[] {
  const placed = items.filter(
    (item) => item.locationName !== null && item.locationName.trim() !== ''
  )

  const gaps: TransferGap[] = []

  for (let i = 0; i < placed.length - 1; i += 1) {
    const current = placed[i]
    const next = placed[i + 1]
    if (current === undefined || next === undefined) continue

    // A transfer already sitting between them IS the answer to this gap.
    if (current.type === JourneyItemType.TRANSFER || next.type === JourneyItemType.TRANSFER) {
      continue
    }

    const from = current.locationName?.trim() ?? ''
    const to = next.locationName?.trim() ?? ''

    if (from.toLowerCase() === to.toLowerCase()) continue

    gaps.push({ afterItemId: current.id, dayNumber: next.dayNumber, from, to })
  }

  return gaps
}

/**
 * How to make one of those journeys.
 *
 * The curated table is consulted first and its rows are handed to the model as
 * facts to preserve. Where the agency has sold a route it knows the price; where
 * it has not, the estimate says so, and the interface shows that difference.
 */
export async function estimateGap(gap: TransferGap, partySize: number, userId: string | null) {
  const curated = await db.routeEstimate.findMany({
    where: {
      fromLocation: gap.from.toLowerCase(),
      toLocation: gap.to.toLowerCase(),
      isActive: true,
    },
    select: {
      mode: true,
      durationMinMinutes: true,
      durationMaxMinutes: true,
      priceMinBdt: true,
      priceMaxBdt: true,
      pricePer: true,
      note: true,
    },
  })

  return estimateTransfer(
    { from: gap.from, to: gap.to, partySize, curated },
    userId === null ? {} : { userId }
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Budget
// ─────────────────────────────────────────────────────────────────────────────

export interface BudgetSummary {
  /** Whole taka, both ends of every estimate summed. */
  estimatedMinBdt: number
  estimatedMaxBdt: number
  budgetMinBdt: number | null
  budgetMaxBdt: number | null
  /** How full the meter reads, capped at 1 so an overrun does not overflow a bar. */
  fraction: number | null
  overBudget: boolean
  /** Items carrying no estimate, so the figure can be honest about itself. */
  unpricedItems: number
}

/**
 * What the plan is likely to cost.
 *
 * PER-PERSON PRICES ARE MULTIPLIED BY THE PARTY, which is the difference between
 * a meter that means something and one reading a quarter of the real number for
 * a family of four. A price with no `per` is taken as covering the whole
 * booking, because that is the safer reading: over-counting a group price
 * startles somebody, under-counting a per-person one misleads them.
 */
export function summariseBudget(
  journey: {
    budgetMinBdt: number | null
    budgetMaxBdt: number | null
    partyAdults: number
    partyChildren: number
  },
  items: readonly {
    estPriceMinBdt: number | null
    estPriceMaxBdt: number | null
    estPricePer: string | null
  }[]
): BudgetSummary {
  const party = Math.max(1, journey.partyAdults + journey.partyChildren)

  let min = 0
  let max = 0
  let unpriced = 0

  for (const item of items) {
    if (item.estPriceMinBdt === null && item.estPriceMaxBdt === null) {
      unpriced += 1
      continue
    }

    const multiplier = item.estPricePer === 'person' ? party : 1
    min += (item.estPriceMinBdt ?? item.estPriceMaxBdt ?? 0) * multiplier
    max += (item.estPriceMaxBdt ?? item.estPriceMinBdt ?? 0) * multiplier
  }

  const ceiling = journey.budgetMaxBdt
  const fraction = ceiling === null || ceiling === 0 ? null : Math.min(1, max / ceiling)

  return {
    estimatedMinBdt: min,
    estimatedMaxBdt: max,
    budgetMinBdt: journey.budgetMinBdt,
    budgetMaxBdt: journey.budgetMaxBdt,
    fraction,
    overBudget: ceiling !== null && max > ceiling,
    unpricedItems: unpriced,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation and the quotation
// ─────────────────────────────────────────────────────────────────────────────

/** The plan as the conflict checker wants it. */
export function toConflictInputs(
  items: readonly {
    id: string
    dayNumber: number
    slot: DaySlot
    startMinute: number | null
    durationMin: number | null
    type: JourneyItemType
    title: string
  }[]
): ConflictInput[] {
  return items.map((item) => ({
    id: item.id,
    dayNumber: item.dayNumber,
    slot: item.slot,
    startMinute: item.startMinute,
    durationMin: item.durationMin,
    type: item.type,
    title: item.title,
  }))
}

export interface ContactInput {
  whatsapp: string
  email?: string | null
  preferredTime?: string | null
  notes?: string | null
}

/**
 * Send the plan for pricing.
 *
 * THREE GATES, IN THIS ORDER, because each produces a different sentence and a
 * traveller deserves the specific one:
 *
 *   1. at least one thing planned — the CTA opens from one, not from perfect
 *   2. no unresolved conflicts — an impossible day priced by hand comes back
 *      wrong and wastes an ops cycle
 *   3. no quote already open — asking twice is the same conversation
 *
 * The Quote row goes through the same table the curated planner uses, so
 * pricing, revisions and sending behave identically and the ops queue stays one
 * screen rather than two.
 */
export async function requestQuotation(journeyId: string, userId: string, contact: ContactInput) {
  const journey = await readJourney(journeyId, userId)

  if (journey.items.length === 0) {
    throw badRequest('Add something to your plan before asking us to price it.')
  }

  const validation = validate(toConflictInputs(journey.items))

  if (validation.status === 'conflicts') {
    const first = validation.conflicts[0]
    throw badRequest(
      `Day ${first?.dayNumber}: ${first?.message}. Resolve the overlaps before requesting a quotation.`
    )
  }

  const whatsapp = contact.whatsapp.trim()
  if (whatsapp === '') throw badRequest('We need a WhatsApp number to send the quotation to.')

  const open = await db.quote.findFirst({
    where: {
      journeyId,
      status: { in: [QuoteStatus.REQUESTED, QuoteStatus.PRICED, QuoteStatus.SENT] },
    },
    select: { id: true },
  })

  if (open !== null) throw conflict('We are already working on a quote for this plan.')

  const quoteId = await db.$transaction(async (tx) => {
    const quote = await tx.quote.create({
      data: {
        userId,
        journeyId,
        travellerNote: contact.notes ?? null,
        status: QuoteStatus.REQUESTED,
      },
      select: { id: true },
    })

    await tx.journey.update({
      where: { id: journeyId },
      data: {
        status: JourneyStatus.QUOTATION_REQUESTED,
        quoteId: quote.id,
        contactWhatsapp: whatsapp,
        contactEmail: contact.email ?? null,
        contactPreferredTime: contact.preferredTime ?? null,
        userNotes: contact.notes ?? null,
      },
    })

    return quote.id
  })

  return { quoteId, journey: await readJourney(journeyId, userId) }
}

/** Update the trip's own facts — the editable chips above the workspace. */
export async function updateBasics(
  journeyId: string,
  userId: string,
  patch: {
    durationDays?: number
    partyAdults?: number
    partyChildren?: number
    budgetMinBdt?: number | null
    budgetMaxBdt?: number | null
    destinations?: string[]
    interests?: string[]
    startDate?: string | null
    endDate?: string | null
  }
) {
  const journey = await readJourney(journeyId, userId)

  /*
   * SHORTENING A TRIP WOULD ORPHAN ITEMS PAST THE NEW END.
   *
   * The trigger refuses a row outside the day range, but it fires on the item
   * rather than on the journey — so a shortened trip would keep items nothing
   * renders and the traveller cannot reach. They are moved to the last day
   * instead of deleted: losing a plan silently is worse than a crowded final day
   * somebody can see and fix.
   */
  if (patch.durationDays !== undefined && patch.durationDays < journey.durationDays) {
    await db.journeyItem.updateMany({
      where: { journeyId, dayNumber: { gt: patch.durationDays } },
      data: { dayNumber: patch.durationDays },
    })
  }

  await db.journey.update({
    where: { id: journeyId },
    data: {
      ...(patch.durationDays === undefined ? {} : { durationDays: patch.durationDays }),
      ...(patch.partyAdults === undefined ? {} : { partyAdults: patch.partyAdults }),
      ...(patch.partyChildren === undefined ? {} : { partyChildren: patch.partyChildren }),
      ...(patch.budgetMinBdt === undefined ? {} : { budgetMinBdt: patch.budgetMinBdt }),
      ...(patch.budgetMaxBdt === undefined ? {} : { budgetMaxBdt: patch.budgetMaxBdt }),
      ...(patch.destinations === undefined ? {} : { destinations: patch.destinations }),
      ...(patch.interests === undefined ? {} : { interests: patch.interests }),
      ...(patch.startDate === undefined
        ? {}
        : { startDate: patch.startDate === null ? null : new Date(patch.startDate) }),
      ...(patch.endDate === undefined
        ? {}
        : { endDate: patch.endDate === null ? null : new Date(patch.endDate) }),
    },
  })

  return readJourney(journeyId, userId)
}
