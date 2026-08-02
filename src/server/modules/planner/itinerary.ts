import type { Prisma } from '@/generated/prisma/client'
import {
  ItineraryBlockKind,
  ItineraryStatus,
  type BudgetBand,
  type TransitMode,
  type TransportPreference,
  type TripPace,
  type TripPurpose,
} from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { MAX_BLOCKS_PER_DAY, MAX_TRIP_DAYS, type TripBrief } from '@/server/ai/schemas'
import { badRequest, conflict, notFound } from '@/server/http/errors'
import {
  getActivitiesByIds,
  matchDestination,
  searchActivities,
  type ActivityDetail,
} from '@/server/modules/catalog/service'
import {
  canGenerateDays,
  claimItineraryCreation,
  claimSaveSlot,
  daysToGenerate,
  entitlementRefused,
  releaseItineraryCreation,
  userActor,
  type DayAllowance,
} from '@/server/modules/entitlements/service'
import {
  detectConflicts,
  planTransitInsertions,
  sortBlocks,
  type TimelineBlock,
  type TimelineConflict,
} from './conflicts'
import { markConverted } from './session'

/**
 * The timeline, and every way it may legally change.
 *
 * Server-authoritative throughout. A client sends what it *wants* — a block at
 * 09:00, a seven-day trip, an activity id — and this module decides what
 * actually happens. Nothing a caller sends is taken as fact: the day count is
 * re-derived from the entitlement, the activity has to resolve against the
 * catalog, and the cost is recomputed from the catalog price rather than read
 * off the request. A planner that took the client's word for any of those would
 * be a planner where the client sets our prices.
 *
 * Ownership is likewise a WHERE clause and not an `if`. `loadOwnedItinerary` is
 * the single door into every write here, and it scopes on `userId` inside the
 * query, so no operation in this file can touch a stranger's trip. A mismatch
 * answers 404, because "not yours" and "does not exist" have to look identical
 * from outside.
 *
 * On conflicts: this module reports them and never resolves one by moving
 * something. The only thing it places on its own initiative is a TRANSIT block
 * into a gap that is already empty — see `syncTransitBlocks`, which deletes only
 * the transfers it wrote itself.
 */

// ── Day shaping ─────────────────────────────────────────────────────────────

/** When a generated day starts and ends. Not a curfew — the packer's canvas. */
export const DAY_START_MINUTE = 9 * 60
export const DAY_END_MINUTE = 20 * 60

/** How full a generated day gets, before travel time is added. */
const ACTIVITIES_BY_PACE: Record<TripPace, number> = {
  RELAXED: 2,
  BALANCED: 3,
  PACKED: 4,
}

/** Used when the catalog has no duration worth trusting. */
const FALLBACK_ACTIVITY_MINUTES = 90

/** The transfer allowance the packer leaves between two activities. */
const PACKING_TRANSFER_MINUTES = 30

// ── Views ───────────────────────────────────────────────────────────────────

export interface ItineraryBlockView {
  id: string
  dayNumber: number
  kind: ItineraryBlockKind
  activityId: string | null
  title: string
  description: string | null
  startMinute: number
  endMinute: number
  transitMode: TransitMode | null
  transitFromBlockId: string | null
  isLocked: boolean
  /** True for a transfer we computed. Ours to recompute; theirs to keep. */
  isEstimate: boolean
  sortOrder: number
  costBdt: number | null
}

export interface ItineraryDayView {
  id: string
  dayNumber: number
  date: string | null
  title: string | null
  notes: string | null
  blocks: ItineraryBlockView[]
}

/** A conflict, plus which day it is on. */
export interface ItineraryConflict extends TimelineConflict {
  dayNumber: number
}

export interface ItineraryView {
  id: string
  plannerSessionId: string | null
  title: string
  destinationId: string | null
  destinationLabel: string
  startDate: string | null
  endDate: string | null
  totalDays: number
  /** How many days actually carry a plan. Below `totalDays` means a wall was hit. */
  plannedDays: number
  partySize: number
  purpose: TripPurpose
  pace: TripPace
  transportPreference: TransportPreference
  budgetBand: BudgetBand | null
  status: ItineraryStatus
  coverImageUrl: string | null
  createdAt: string
  updatedAt: string
  days: ItineraryDayView[]
  conflicts: ItineraryConflict[]
  /** Sum of every block cost, whole taka. A null cost counts as zero, not unknown. */
  estimatedTotalBdt: number
}

export interface ItinerarySummaryView {
  id: string
  title: string
  destinationLabel: string
  startDate: string | null
  totalDays: number
  partySize: number
  status: ItineraryStatus
  updatedAt: string
}

// ── Dates ───────────────────────────────────────────────────────────────────

/** `@db.Date` columns carry a UTC midnight; the wire wants `YYYY-MM-DD`. */
function toDateString(date: Date | null): string | null {
  return date === null ? null : date.toISOString().slice(0, 10)
}

/** `YYYY-MM-DD` to the UTC midnight Postgres stores for a `date`. */
export function fromDateString(value: string | null | undefined): Date | null {
  if (!value) return null
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(Date.UTC(year, month - 1, day))
}

/** Day 1 is the start date itself, not the day after it. */
export function dateForDay(startDate: Date | null, dayNumber: number): Date | null {
  if (startDate === null) return null
  const date = new Date(startDate.getTime())
  date.setUTCDate(date.getUTCDate() + (dayNumber - 1))
  return date
}

/**
 * The weekday a day falls on, or null when the trip has no dates.
 *
 * Null suppresses opening-hours checking — a warning derived from a guessed
 * weekday changes meaning the moment they pick their dates, and a warning that
 * moves is worse than none at all.
 */
function dayOfWeekFor(date: Date | null): number | null {
  return date === null ? null : date.getUTCDay()
}

// ── Loading ─────────────────────────────────────────────────────────────────

const BLOCK_SELECT = {
  id: true,
  kind: true,
  activityId: true,
  title: true,
  description: true,
  startMinute: true,
  endMinute: true,
  transitMode: true,
  transitFromBlockId: true,
  isLocked: true,
  isEstimate: true,
  sortOrder: true,
  costBdt: true,
} satisfies Prisma.ItineraryBlockSelect

const ITINERARY_SELECT = {
  id: true,
  userId: true,
  plannerSessionId: true,
  title: true,
  destinationId: true,
  destinationLabel: true,
  startDate: true,
  endDate: true,
  totalDays: true,
  partySize: true,
  purpose: true,
  pace: true,
  transportPreference: true,
  budgetBand: true,
  status: true,
  coverImageUrl: true,
  createdAt: true,
  updatedAt: true,
  days: {
    orderBy: { dayNumber: 'asc' },
    select: {
      id: true,
      dayNumber: true,
      date: true,
      title: true,
      notes: true,
      blocks: { orderBy: [{ startMinute: 'asc' }, { sortOrder: 'asc' }], select: BLOCK_SELECT },
    },
  },
} satisfies Prisma.ItinerarySelect

type ItineraryRow = Prisma.ItineraryGetPayload<{ select: typeof ITINERARY_SELECT }>
type BlockRow = ItineraryRow['days'][number]['blocks'][number]

/**
 * The only way into a write.
 *
 * Scoped on `userId` in the query itself. Every mutation below starts here, so
 * "ownership check on every route" is a property of this function rather than a
 * habit each route has to remember to perform.
 */
export async function loadOwnedItinerary(
  userId: string,
  itineraryId: string
): Promise<ItineraryRow> {
  const row = await db.itinerary.findFirst({
    where: { id: itineraryId, userId },
    select: ITINERARY_SELECT,
  })

  if (row === null) throw notFound('That itinerary was not found.')

  return row
}

/**
 * Hydrate a stored block into something the conflict rules can reason about.
 *
 * Retired activities are resolved too. A saved trip must not lose its museum
 * because ops archived the row — the block stays, its coordinates stay, and the
 * plan keeps working.
 */
function toTimelineBlock(block: BlockRow, activities: Map<string, ActivityDetail>): TimelineBlock {
  const activity = block.activityId === null ? undefined : activities.get(block.activityId)

  return {
    id: block.id,
    kind: block.kind,
    activityId: block.activityId,
    title: block.title,
    startMinute: block.startMinute,
    endMinute: block.endMinute,
    isEstimate: block.isEstimate,
    location: activity?.location ?? null,
    openingHours: activity?.openingHours,
  }
}

/**
 * The read-side rule, decided: a day is visible while the plan entitles it.
 *
 * The write side and the read side used to disagree, and the disagreement was
 * worth money. `regenerateDay` refuses day five to a two-day plan, but every day
 * ever generated stayed readable and editable forever — so a single month of
 * PREMIUM_10 bought ten permanently full-length itineraries, which is exactly
 * the thing the 200 BDT per-itinerary unlock exists to sell. Guarding the write
 * side alone (see `assertDayWithinAllowance`) would only have half-closed it:
 * the days are already there, and reading them is the whole product.
 *
 * So the allowance governs BOTH. `days` is truncated to `allowance.maxDays` for
 * an itinerary that is not unlocked, and `plannedDays` reports what is visible.
 * `totalDays` still reports the trip they asked for, so `plannedDays < totalDays`
 * keeps its documented meaning — the plan stops at an entitlement wall — and a
 * client can still render the offer that lifts it.
 *
 * What this is NOT is deletion. The day rows and their blocks stay exactly where
 * they are: unlocking this itinerary, or subscribing again, makes them visible
 * again with every edit intact. A subscription rents access to length; the 200
 * BDT unlock buys it outright, per itinerary, forever. That is the product, and
 * now it is also the code.
 */
async function assemble(row: ItineraryRow, allowance: DayAllowance): Promise<ItineraryView> {
  const visible = row.days.filter((day) => day.dayNumber <= allowance.maxDays)

  const activityIds = visible.flatMap((day) =>
    day.blocks.flatMap((block) => (block.activityId === null ? [] : [block.activityId]))
  )
  const activities = await getActivitiesByIds(activityIds)

  const days: ItineraryDayView[] = []
  const conflicts: ItineraryConflict[] = []
  let estimatedTotalBdt = 0

  for (const day of visible) {
    const timeline = day.blocks.map((block) => toTimelineBlock(block, activities))

    for (const found of detectConflicts({
      blocks: timeline,
      transportPreference: row.transportPreference,
      dayOfWeek: dayOfWeekFor(day.date),
    })) {
      conflicts.push({ ...found, dayNumber: day.dayNumber })
    }

    days.push({
      id: day.id,
      dayNumber: day.dayNumber,
      date: toDateString(day.date),
      title: day.title,
      notes: day.notes,
      blocks: sortBlocks(day.blocks.map((block) => ({ ...block, dayNumber: day.dayNumber }))),
    })

    for (const block of day.blocks) estimatedTotalBdt += block.costBdt ?? 0
  }

  return {
    id: row.id,
    plannerSessionId: row.plannerSessionId,
    title: row.title,
    destinationId: row.destinationId,
    destinationLabel: row.destinationLabel,
    startDate: toDateString(row.startDate),
    endDate: toDateString(row.endDate),
    totalDays: row.totalDays,
    // What they can see, not what exists. Below `totalDays` means a wall.
    plannedDays: days.length,
    partySize: row.partySize,
    purpose: row.purpose,
    pace: row.pace,
    transportPreference: row.transportPreference,
    budgetBand: row.budgetBand,
    status: row.status,
    coverImageUrl: row.coverImageUrl,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    days,
    conflicts,
    estimatedTotalBdt,
  }
}

/**
 * One itinerary, hydrated as far as the plan entitles, for its owner only.
 *
 * The allowance is resolved here rather than passed in, because every caller of
 * this function is answering a request and none of them should be able to choose
 * how much of the trip comes back. An allowance the caller supplies is an
 * allowance a caller can get wrong.
 */
export async function getItinerary(userId: string, itineraryId: string): Promise<ItineraryView> {
  const [row, allowance] = await Promise.all([
    loadOwnedItinerary(userId, itineraryId),
    canGenerateDays(userActor(userId), itineraryId),
  ])

  return assemble(row, allowance)
}

export interface ListItinerariesInput {
  status?: ItineraryStatus | undefined
  limit?: number | undefined
  offset?: number | undefined
}

export const MAX_ITINERARY_PAGE = 50

export async function listItineraries(
  userId: string,
  input: ListItinerariesInput = {}
): Promise<{ items: ItinerarySummaryView[]; total: number }> {
  const take = Math.min(Math.max(1, Math.trunc(input.limit ?? 20)), MAX_ITINERARY_PAGE)
  const skip = Math.max(0, Math.trunc(input.offset ?? 0))
  const where = { userId, ...(input.status ? { status: input.status } : {}) }

  const [rows, total] = await Promise.all([
    db.itinerary.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take,
      skip,
      select: {
        id: true,
        title: true,
        destinationLabel: true,
        startDate: true,
        totalDays: true,
        partySize: true,
        status: true,
        updatedAt: true,
      },
    }),
    db.itinerary.count({ where }),
  ])

  return {
    items: rows.map((row) => ({
      ...row,
      startDate: toDateString(row.startDate),
      updatedAt: row.updatedAt.toISOString(),
    })),
    total,
  }
}

// ── Transit synchronisation ─────────────────────────────────────────────────

/**
 * Redraw the transfers on one day.
 *
 * Deletes only blocks marked `isEstimate` — the ones we wrote. A ferry the
 * traveller booked and typed in themselves is a fact about their trip, and a
 * "resync the transfers" that quietly removed it is the kind of data loss nobody
 * forgives. That is the entire reason the column exists.
 *
 * Runs after every mutation. Because `planTransitInsertions` only fires between
 * *adjacent* activities, re-running it over a day that already has its transfers
 * proposes nothing — so calling this as often as is convenient is safe.
 */
export async function syncTransitBlocks(
  dayId: string,
  preference: TransportPreference
): Promise<void> {
  const day = await db.itineraryDay.findUnique({
    where: { id: dayId },
    select: { blocks: { select: BLOCK_SELECT } },
  })
  if (day === null) return

  await db.itineraryBlock.deleteMany({
    where: { dayId, kind: ItineraryBlockKind.TRANSIT, isEstimate: true },
  })

  const remaining = day.blocks.filter(
    (block) => !(block.kind === ItineraryBlockKind.TRANSIT && block.isEstimate)
  )

  const activities = await getActivitiesByIds(
    remaining.flatMap((block) => (block.activityId === null ? [] : [block.activityId]))
  )

  const insertions = planTransitInsertions(
    remaining.map((block) => toTimelineBlock(block, activities)),
    preference
  )

  if (insertions.length === 0) return

  await db.itineraryBlock.createMany({
    data: insertions.map((insertion) => ({
      dayId,
      kind: ItineraryBlockKind.TRANSIT,
      title: insertion.title,
      description:
        insertion.distanceKm === null
          ? 'Estimated transfer. We hold no coordinates for one of these stops, so please confirm the timing.'
          : `Estimated transfer of about ${insertion.estimatedMinutes} minutes over ${insertion.distanceKm} km. Not a routed duration.`,
      startMinute: insertion.startMinute,
      endMinute: insertion.endMinute,
      transitMode: insertion.mode,
      transitFromBlockId: insertion.fromBlockId,
      isEstimate: true,
      // Blocks are read back ordered by startMinute; this only breaks ties.
      sortOrder: insertion.startMinute,
    })),
  })
}

// ── Day generation ──────────────────────────────────────────────────────────

/**
 * Cost of one block, in whole taka.
 *
 * Recomputed from the catalog and the party size on every write. A caller may
 * not send a price — that would let the client decide what we charge.
 */
function blockCostBdt(activity: ActivityDetail, partySize: number): number | null {
  if (activity.pricePerPersonBdt === null) return null
  return activity.pricePerPersonBdt * Math.max(1, partySize)
}

interface PlannedBlock {
  kind: ItineraryBlockKind
  activityId: string | null
  title: string
  description: string | null
  startMinute: number
  endMinute: number
  costBdt: number | null
  sortOrder: number
}

/**
 * Lay activities out across one day, around whatever is pinned.
 *
 * Deterministic and catalog-only: it places rows the catalog returned, in the
 * order the catalog ranked them, into the first slot that fits after the
 * previous one plus a transfer. It is not a model call — day generation runs on
 * a paid request path, and spending a generation to decide that 09:00 comes
 * before 11:00 would be spending it badly.
 *
 * Locked blocks are obstacles, never furniture to be moved: the cursor jumps
 * over them and nothing pinned is touched.
 */
function packDay(
  candidates: readonly ActivityDetail[],
  locked: readonly { startMinute: number; endMinute: number }[],
  options: { pace: TripPace; partySize: number; transferMinutes: number }
): PlannedBlock[] {
  const target = ACTIVITIES_BY_PACE[options.pace] ?? ACTIVITIES_BY_PACE.BALANCED
  const obstacles = [...locked].sort((a, b) => a.startMinute - b.startMinute)

  const planned: PlannedBlock[] = []
  let cursor = DAY_START_MINUTE

  for (const activity of candidates) {
    if (planned.length >= target || planned.length >= MAX_BLOCKS_PER_DAY) break

    const duration = Math.max(15, activity.durationMinutes || FALLBACK_ACTIVITY_MINUTES)

    // Slide past anything pinned this would collide with. A loop, because
    // clearing one obstacle can land on the next.
    let placed = false
    for (let attempt = 0; attempt <= obstacles.length; attempt += 1) {
      const blocker = obstacles.find(
        (obstacle) => cursor < obstacle.endMinute && obstacle.startMinute < cursor + duration
      )
      if (blocker === undefined) {
        placed = true
        break
      }
      cursor = blocker.endMinute + options.transferMinutes
    }

    if (!placed || cursor + duration > DAY_END_MINUTE) continue

    planned.push({
      kind: ItineraryBlockKind.ACTIVITY,
      activityId: activity.id,
      title: activity.name,
      description: activity.summary,
      startMinute: cursor,
      endMinute: cursor + duration,
      costBdt: blockCostBdt(activity, options.partySize),
      sortOrder: cursor,
    })

    cursor += duration + options.transferMinutes
  }

  return planned
}

interface GenerateDayInput {
  itinerary: Pick<ItineraryRow, 'destinationId' | 'partySize' | 'pace' | 'transportPreference'>
  dayId: string
  /**
   * Which day of the trip this is.
   *
   * Used only once the catalogue has been exhausted, to vary WHICH activities
   * repeat. Without it every exhausted day re-runs the same ranked query and
   * gets the same answer, so days 5, 6 and 7 of a week in Cox's Bazar came back
   * byte-identical — three copies of one day, which is a worse artefact than
   * the empty days this replaced.
   */
  dayNumber: number
  /** Ids already used elsewhere in the trip, so day 3 is not day 1 again. */
  excludeActivityIds: readonly string[]
  interests?: readonly string[] | undefined
}

/** Rebuild one day's blocks. Returns the activity ids it placed. */
async function generateDayBlocks(input: GenerateDayInput): Promise<string[]> {
  const { itinerary } = input

  const locked = await db.itineraryBlock.findMany({
    where: { dayId: input.dayId, isLocked: true },
    select: { startMinute: true, endMinute: true },
  })

  // Everything unpinned goes, our own transfers included: the day is being
  // rebuilt, and a transfer between two activities that no longer exist is
  // worse than no transfer at all.
  await db.itineraryBlock.deleteMany({ where: { dayId: input.dayId, isLocked: false } })

  /*
   * Candidates: everything unused first, then repeats only once that runs out.
   *
   * WHY A SECOND SEARCH EXISTS AT ALL. `excludeActivityIds` becomes a hard
   * `notIn` (see `activityWhere` in modules/catalog/service.ts), so once a trip
   * has consumed every activity in its destination the filtered search returns
   * nothing and this function used to create a day with no activities in it —
   * silently, and reported as a success. At ten activities per destination and
   * three a day at BALANCED pace, that is day four of a week-long trip. Those
   * empty days could never be repaired either: regenerating one runs the same
   * exhausted query and gets the same nothing.
   *
   * A REPEATED ACTIVITY IS A WORSE PLAN THAN A FRESH ONE AND A FAR BETTER PLAN
   * THAN AN EMPTY DAY. So exhaustion degrades rather than fails: unused
   * activities are still preferred and still come first, and only the shortfall
   * is topped up from the unfiltered pool.
   *
   * NOTHING MARKS THE REPEAT IN THE DATABASE, deliberately. An `isRepeat`
   * column would be a denormalisation that goes stale the moment a block moves
   * or is deleted. The itinerary response already carries every day and every
   * block, so "this activity is also on day 2" is derivable by the client from
   * data it already holds — correct by construction, and free.
   */
  const wanted = ACTIVITIES_BY_PACE[itinerary.pace]

  const fresh = await searchActivities({
    destinationId: itinerary.destinationId ?? undefined,
    interests: input.interests,
    partySize: itinerary.partySize,
    excludeActivityIds: input.excludeActivityIds,
    limit: 12,
  })

  let candidates = fresh.activities

  if (candidates.length < wanted) {
    const topUp = await searchActivities({
      destinationId: itinerary.destinationId ?? undefined,
      interests: input.interests,
      partySize: itinerary.partySize,
      // No exclusions: this pass is precisely what they were preventing.
      limit: 12,
    })

    const already = new Set(candidates.map((activity) => activity.id))
    const spare = topUp.activities.filter((activity) => !already.has(activity.id))

    /*
     * Rotated by day number, so exhausted days differ from one another.
     *
     * `searchActivities` ranks deterministically, so without this every day
     * past the catalogue's depth appended the same list in the same order and
     * the packer chose the same three — days 5, 6 and 7 came back identical.
     * Rotating the starting offset means each day begins from a different point
     * in the pool, and a week in a ten-activity destination reads as a trip
     * that revisits favourites rather than one day photocopied.
     *
     * Rotation, not a shuffle: this must be reproducible. Regenerating day 5
     * has to give day 5 again, and `Math.random()` here would mean the plan a
     * traveller sees depends on when they pressed the button.
     */
    const offset = spare.length === 0 ? 0 : input.dayNumber % spare.length
    const rotated = [...spare.slice(offset), ...spare.slice(0, offset)]

    candidates = [...candidates, ...rotated]
  }

  // Genuinely nothing to plan: a destination with no published activities, or
  // an itinerary with no destination at all. Unlike the exhaustion case above,
  // no second query can fix this, so an empty day is the honest result.
  if (candidates.length === 0) {
    await syncTransitBlocks(input.dayId, itinerary.transportPreference)
    return []
  }

  const search = { activities: candidates }

  // Search returns summaries; the packer needs durations and opening hours,
  // which only the detail shape carries.
  const details = await getActivitiesByIds(search.activities.map((activity) => activity.id))
  const ordered = search.activities.flatMap((activity) => {
    const detail = details.get(activity.id)
    return detail === undefined ? [] : [detail]
  })

  const planned = packDay(ordered, locked, {
    pace: itinerary.pace,
    partySize: itinerary.partySize,
    transferMinutes: PACKING_TRANSFER_MINUTES,
  })

  if (planned.length > 0) {
    await db.itineraryBlock.createMany({
      data: planned.map((block) => ({ ...block, dayId: input.dayId })),
    })
  }

  await syncTransitBlocks(input.dayId, itinerary.transportPreference)

  return planned.flatMap((block) => (block.activityId === null ? [] : [block.activityId]))
}

// ── Creation ────────────────────────────────────────────────────────────────

export interface CreateFromBriefInput {
  userId: string
  brief: TripBrief
  plannerSessionId?: string | null
  /** What they asked for. Clamped by the entitlement, never trusted as-is. */
  requestedDays?: number | undefined
  title?: string | undefined
}

export interface CreateFromBriefResult {
  itinerary: ItineraryView
  /** How many days they may have, why, and what would lift the wall. */
  allowance: DayAllowance
  requestedDays: number
  generatedDays: number
}

/**
 * Turn a brief into a real itinerary.
 *
 * Two different entitlement questions, asked in this order, and they are not
 * interchangeable.
 *
 * How LONG — `canGenerateDays` — decides the length and never refuses for asking
 * too much: a FREE traveller who asked for seven days gets two days, a `refusal`
 * carrying a reason code and an offer, and a plan that is genuinely good for
 * those two days. Not a silent truncation, and not a 403.
 *
 * How MANY — `claimItineraryCreation` — is the wall. It is the per-period
 * allowance the paid tiers are actually sold on, and this is the only route that
 * materialises an itinerary, so it was also the only place that could enforce
 * it. Before, nothing did: `canGenerateDays` reads `maxItineraryDays`, every
 * premium tier seeds that null, and the usage counter was incremented by a line
 * at the bottom of this function that nothing ever read back. A PREMIUM_10
 * subscriber who had spent their ten kept generating forever.
 *
 * The claim is taken BEFORE the write and handed back if the write fails, for
 * the reason `refundPrompt` exists: claiming afterwards is the race, and the
 * price of doing it correctly is having to undo it.
 *
 * `totalDays` records what they asked for, not what we generated. The trip
 * really is seven days long; we have planned two of them, and storing two would
 * erase the fact that there is anything left to unlock.
 */
export async function createItineraryFromBrief(
  input: CreateFromBriefInput
): Promise<CreateFromBriefResult> {
  const { brief } = input

  if (!brief.destination) {
    throw badRequest('The trip brief needs a destination before an itinerary can be built.', [
      { path: 'brief.destination', message: 'A destination is required.' },
    ])
  }

  const requestedDays = Math.max(
    1,
    Math.min(MAX_TRIP_DAYS, Math.trunc(input.requestedDays ?? brief.totalDays ?? 1))
  )

  const actor = userActor(input.userId)

  // No itinerary row yet, so there is nothing that could have been unlocked:
  // the answer is the plan's cap, which is the conservative and correct reading.
  const allowance = await canGenerateDays(actor, null)
  const generatedDays = daysToGenerate(requestedDays, allowance)

  if (generatedDays < 1) {
    // Nothing partial to hand back. This is the exhausted-quota wall rather than
    // the day cap, so the caller is refused outright.
    throw entitlementRefused(
      allowance.refusal ?? {
        reason: 'FREE_DAY_LIMIT',
        message: 'Your plan does not include itinerary generation.',
        upgrade: null,
      }
    )
  }

  // Claimed once per itinerary, not once per day: the product sells itineraries.
  // Refused here means the allowance is spent, which is a wall and not a
  // truncation — there is no good half of an eleventh itinerary.
  const claim = await claimItineraryCreation(input.userId)
  if (!claim.allowed) throw entitlementRefused(claim.refusal)

  try {
    const matched = brief.destinationId ? null : await matchDestination(brief.destination)
    const destinationId = brief.destinationId ?? matched?.id ?? null

    const startDate = fromDateString(brief.startDate)
    const partySize = Math.max(1, brief.partySize ?? 1)

    const created = await db.itinerary.create({
      data: {
        userId: input.userId,
        plannerSessionId: input.plannerSessionId ?? null,
        title: input.title?.trim() || `${brief.destination} trip`,
        destinationId,
        destinationLabel: brief.destination,
        startDate,
        endDate: dateForDay(startDate, requestedDays),
        totalDays: requestedDays,
        partySize,
        ...(brief.purpose ? { purpose: brief.purpose } : {}),
        ...(brief.pace ? { pace: brief.pace } : {}),
        ...(brief.transportPreference ? { transportPreference: brief.transportPreference } : {}),
        ...(brief.budgetBand ? { budgetBand: brief.budgetBand } : {}),
        days: {
          create: Array.from({ length: generatedDays }, (_, index) => ({
            dayNumber: index + 1,
            date: dateForDay(startDate, index + 1),
          })),
        },
      },
      select: ITINERARY_SELECT,
    })

    const used: string[] = []
    for (const day of created.days) {
      const placed = await generateDayBlocks({
        itinerary: created,
        dayId: day.id,
        dayNumber: day.dayNumber,
        excludeActivityIds: used,
        interests: brief.interests,
      })
      used.push(...placed)
    }

    if (input.plannerSessionId) await markConverted(input.plannerSessionId)

    return {
      itinerary: await getItinerary(input.userId, created.id),
      allowance,
      requestedDays,
      generatedDays,
    }
  } catch (e) {
    // The traveller got no itinerary, so they keep the allowance. Without this a
    // catalog outage would spend a subscriber's tenth generation on nothing, and
    // there is no way for them to appeal it.
    await releaseItineraryCreation(input.userId)
    throw e
  }
}

// ── The day wall ────────────────────────────────────────────────────────────

/**
 * Refuse a day the plan does not reach.
 *
 * One guard, used by every write that names a day, because the alternative is
 * what shipped: `regenerateDay` checked, `addBlock` and `moveBlock` did not, and
 * a lapsed subscriber whose `maxItineraryDays` had dropped back to FREE's 2 kept
 * full editing rights over every day they had ever generated. Adding a block to
 * day six is generating day six, one block at a time.
 *
 * Throws rather than truncating: unlike creating a trip there is no partial
 * success to narrate here. The traveller asked to touch one specific day, and
 * the honest answer is the reason code plus the offer that lifts it.
 */
function assertDayWithinAllowance(dayNumber: number, allowance: DayAllowance): void {
  if (dayNumber <= allowance.maxDays) return

  throw entitlementRefused(
    allowance.refusal ?? {
      reason: 'FREE_DAY_LIMIT',
      message: `Your plan covers the first ${allowance.maxDays} days of a trip.`,
      upgrade: null,
    }
  )
}

// ── Regeneration ────────────────────────────────────────────────────────────

export interface RegenerateDayResult {
  itinerary: ItineraryView
  allowance: DayAllowance
  dayNumber: number
}

/**
 * Rebuild one day from the catalog, around anything pinned.
 *
 * Refuses a day beyond the entitlement with the structured reason rather than
 * generating it: day 5 of a FREE traveller's trip is exactly the wall the unlock
 * exists to lift, and quietly filling it gives the product away.
 */
export async function regenerateDay(
  userId: string,
  itineraryId: string,
  dayNumber: number
): Promise<RegenerateDayResult> {
  const itinerary = await loadOwnedItinerary(userId, itineraryId)
  const day = itinerary.days.find((candidate) => candidate.dayNumber === dayNumber)

  if (day === undefined) throw notFound(`This itinerary has no day ${dayNumber}.`)

  const allowance = await canGenerateDays(userActor(userId), itineraryId)
  assertDayWithinAllowance(dayNumber, allowance)

  // Ids used on the OTHER days, so a regenerated day does not simply repeat one
  // the traveller already has.
  const used = itinerary.days
    .filter((candidate) => candidate.dayNumber !== dayNumber)
    .flatMap((candidate) =>
      candidate.blocks.flatMap((block) => (block.activityId === null ? [] : [block.activityId]))
    )

  await generateDayBlocks({
    itinerary,
    dayId: day.id,
    dayNumber,
    excludeActivityIds: used,
  })

  return { itinerary: await getItinerary(userId, itineraryId), allowance, dayNumber }
}

/**
 * Extend a plan that was cut short, once the traveller is entitled to more.
 *
 * For use after an unlock or an upgrade. Adds only the days that are missing;
 * days that already exist are left exactly as the traveller left them.
 */
export interface ExtendResult {
  itinerary: ItineraryView
  /** Day numbers this call planned. Empty when there was nothing to do. */
  addedDays: number[]
  /**
   * Days inside the trip that this call could NOT reach, because the
   * entitlement stops short of the trip's length.
   *
   * THE FIELD EXISTS SO THE BUTTON CANNOT LIE. Without it, a FREE traveller
   * with a 2-day allowance and a 7-day trip presses "plan the remaining days",
   * every day within reach already exists, the loop skips all of them, and the
   * call returns a perfectly successful response having done nothing at all.
   * The client needs to tell "there was nothing left to plan" apart from "there
   * is plenty left and your plan will not reach it", and only the server knows
   * which.
   */
  unreachableDays: number[]
  allowance: DayAllowance
}

export async function extendToEntitlement(
  userId: string,
  itineraryId: string
): Promise<ExtendResult> {
  const itinerary = await loadOwnedItinerary(userId, itineraryId)
  const allowance = await canGenerateDays(userActor(userId), itineraryId)

  const target = Math.min(itinerary.totalDays, allowance.maxDays)
  const existing = new Set(itinerary.days.map((day) => day.dayNumber))
  const addedDays: number[] = []

  // Everything the trip asked for that the allowance will not stretch to.
  const unreachableDays: number[] = []
  for (let dayNumber = target + 1; dayNumber <= itinerary.totalDays; dayNumber += 1) {
    unreachableDays.push(dayNumber)
  }

  const used = itinerary.days.flatMap((day) =>
    day.blocks.flatMap((block) => (block.activityId === null ? [] : [block.activityId]))
  )

  for (let dayNumber = 1; dayNumber <= target; dayNumber += 1) {
    if (existing.has(dayNumber)) continue

    const day = await db.itineraryDay.create({
      data: { itineraryId, dayNumber, date: dateForDay(itinerary.startDate, dayNumber) },
      select: { id: true },
    })

    const placed = await generateDayBlocks({
      itinerary,
      dayId: day.id,
      dayNumber,
      excludeActivityIds: used,
    })
    used.push(...placed)
    addedDays.push(dayNumber)
  }

  return {
    itinerary: await getItinerary(userId, itineraryId),
    addedDays,
    unreachableDays,
    allowance,
  }
}

// ── Itinerary-level edits ───────────────────────────────────────────────────

export interface UpdateItineraryInput {
  title?: string | undefined
  startDate?: string | null | undefined
  partySize?: number | undefined
  purpose?: TripPurpose | undefined
  pace?: TripPace | undefined
  transportPreference?: TransportPreference | undefined
  budgetBand?: BudgetBand | null | undefined
  coverImageUrl?: string | null | undefined
}

/**
 * Edit the trip's own fields.
 *
 * Two of these ripple. Moving the start date re-dates every day, which changes
 * the weekday each one falls on and therefore which opening-hours warnings
 * apply. Changing the transport preference invalidates every transfer we
 * estimated. Both are followed by a resync rather than left to drift.
 */
export async function updateItinerary(
  userId: string,
  itineraryId: string,
  input: UpdateItineraryInput
): Promise<ItineraryView> {
  const itinerary = await loadOwnedItinerary(userId, itineraryId)

  const startDate =
    input.startDate === undefined ? itinerary.startDate : fromDateString(input.startDate)
  const dateChanged = startDate?.getTime() !== itinerary.startDate?.getTime()
  const transportChanged =
    input.transportPreference !== undefined &&
    input.transportPreference !== itinerary.transportPreference

  await db.itinerary.update({
    where: { id: itineraryId },
    data: {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.startDate !== undefined
        ? { startDate, endDate: dateForDay(startDate, itinerary.totalDays) }
        : {}),
      ...(input.partySize !== undefined ? { partySize: Math.max(1, input.partySize) } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.pace !== undefined ? { pace: input.pace } : {}),
      ...(input.transportPreference !== undefined
        ? { transportPreference: input.transportPreference }
        : {}),
      ...(input.budgetBand !== undefined ? { budgetBand: input.budgetBand } : {}),
      ...(input.coverImageUrl !== undefined ? { coverImageUrl: input.coverImageUrl } : {}),
    },
    select: { id: true },
  })

  if (dateChanged) {
    for (const day of itinerary.days) {
      await db.itineraryDay.update({
        where: { id: day.id },
        data: { date: dateForDay(startDate, day.dayNumber) },
        select: { id: true },
      })
    }
  }

  if (transportChanged && input.transportPreference !== undefined) {
    for (const day of itinerary.days) {
      await syncTransitBlocks(day.id, input.transportPreference)
    }
  }

  return getItinerary(userId, itineraryId)
}

/** Named for the operation the product actually has a button for. */
export async function setTransportPreference(
  userId: string,
  itineraryId: string,
  transportPreference: TransportPreference
): Promise<ItineraryView> {
  return updateItinerary(userId, itineraryId, { transportPreference })
}

// ── Block edits ─────────────────────────────────────────────────────────────

export interface AddBlockInput {
  kind: ItineraryBlockKind
  /** Required for ACTIVITY, forbidden otherwise. Must resolve to a live row. */
  activityId?: string | null | undefined
  title?: string | undefined
  description?: string | null | undefined
  startMinute: number
  endMinute: number
  transitMode?: TransitMode | null | undefined
  isLocked?: boolean | undefined
}

function assertMinuteRange(startMinute: number, endMinute: number): void {
  if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute >= 1440) {
    throw badRequest('startMinute must be a whole number of minutes from midnight, 0 to 1439.', [
      { path: 'startMinute', message: 'Out of range.' },
    ])
  }
  if (!Number.isInteger(endMinute) || endMinute <= startMinute || endMinute > 2880) {
    throw badRequest('endMinute must be after startMinute and no later than the next midnight.', [
      { path: 'endMinute', message: 'Out of range.' },
    ])
  }
}

/**
 * Resolve and validate an activity reference.
 *
 * A retired activity is refused on the way IN, even though an existing block
 * pointing at one is honoured. Adding inventory we can no longer sell is a new
 * mistake; keeping a plan that already contains it is not.
 */
async function resolveActivity(
  kind: ItineraryBlockKind,
  activityId: string | null | undefined
): Promise<ActivityDetail | null> {
  if (kind !== ItineraryBlockKind.ACTIVITY) {
    if (activityId) {
      // The mirror of the catalog rule: a meal carrying an activity id is
      // sellable inventory routed around the check that exists to validate it.
      throw badRequest(`activityId is only valid on ACTIVITY blocks, not ${kind}.`, [
        { path: 'activityId', message: 'Not allowed for this block kind.' },
      ])
    }
    return null
  }

  if (!activityId) {
    throw badRequest('ACTIVITY blocks must reference a catalog activity by id.', [
      { path: 'activityId', message: 'Required for ACTIVITY blocks.' },
    ])
  }

  const activity = (await getActivitiesByIds([activityId])).get(activityId)

  if (activity === undefined || !activity.isActive) {
    throw badRequest('That activity is not in the catalog, or is no longer offered.', [
      { path: 'activityId', message: 'Unknown activity.' },
    ])
  }

  return activity
}

export interface BlockMutationResult {
  itinerary: ItineraryView
  blockId: string
}

export async function addBlock(
  userId: string,
  itineraryId: string,
  dayNumber: number,
  input: AddBlockInput
): Promise<BlockMutationResult> {
  const itinerary = await loadOwnedItinerary(userId, itineraryId)
  const day = itinerary.days.find((candidate) => candidate.dayNumber === dayNumber)

  if (day === undefined) throw notFound(`This itinerary has no day ${dayNumber}.`)

  // The same wall `regenerateDay` enforces. Building day six block by block is
  // still building day six.
  assertDayWithinAllowance(dayNumber, await canGenerateDays(userActor(userId), itineraryId))

  assertMinuteRange(input.startMinute, input.endMinute)

  // Our own transfers do not count against the ceiling — they are ours to redraw,
  // and a day should not become unaddable because we drew four of them.
  const authored = day.blocks.filter(
    (block) => !(block.kind === ItineraryBlockKind.TRANSIT && block.isEstimate)
  )
  if (authored.length >= MAX_BLOCKS_PER_DAY) {
    throw conflict(`A day may hold at most ${MAX_BLOCKS_PER_DAY} blocks.`)
  }

  const activity = await resolveActivity(input.kind, input.activityId)

  const created = await db.itineraryBlock.create({
    data: {
      dayId: day.id,
      kind: input.kind,
      activityId: activity?.id ?? null,
      title: input.title?.trim() || activity?.name || input.kind,
      description: input.description ?? activity?.summary ?? null,
      startMinute: input.startMinute,
      endMinute: input.endMinute,
      transitMode: input.transitMode ?? null,
      isLocked: input.isLocked ?? false,
      // Authored by a person, so `syncTransitBlocks` will never remove it.
      isEstimate: false,
      sortOrder: input.startMinute,
      // Never from the request. The client does not set our prices.
      costBdt: activity === null ? null : blockCostBdt(activity, itinerary.partySize),
    },
    select: { id: true },
  })

  await syncTransitBlocks(day.id, itinerary.transportPreference)

  // Deliberately no conflict check that could reject this write. A traveller is
  // allowed to build a day we think is impossible; our job is to say so, in the
  // `conflicts` array they get straight back.
  return { itinerary: await getItinerary(userId, itineraryId), blockId: created.id }
}

export interface MoveBlockInput {
  startMinute?: number | undefined
  endMinute?: number | undefined
  /** Moving a block to another day of the same itinerary. */
  dayNumber?: number | undefined
  title?: string | undefined
  description?: string | null | undefined
  isLocked?: boolean | undefined
  transitMode?: TransitMode | null | undefined
}

/**
 * Move or retime one block.
 *
 * Both days are resynced when a block changes day: the one it left has a gap
 * where a transfer no longer makes sense, and the one it arrived on needs new
 * transfers of its own.
 */
export async function moveBlock(
  userId: string,
  itineraryId: string,
  blockId: string,
  input: MoveBlockInput
): Promise<BlockMutationResult> {
  const itinerary = await loadOwnedItinerary(userId, itineraryId)

  const sourceDay = itinerary.days.find((day) => day.blocks.some((block) => block.id === blockId))
  const block = sourceDay?.blocks.find((candidate) => candidate.id === blockId)

  if (sourceDay === undefined || block === undefined) {
    throw notFound('That block is not part of this itinerary.')
  }

  const startMinute = input.startMinute ?? block.startMinute
  const endMinute = input.endMinute ?? block.endMinute
  assertMinuteRange(startMinute, endMinute)

  const targetDay =
    input.dayNumber === undefined
      ? sourceDay
      : itinerary.days.find((day) => day.dayNumber === input.dayNumber)

  if (targetDay === undefined) throw notFound(`This itinerary has no day ${input.dayNumber}.`)

  // BOTH ends are checked. Guarding only the target would leave day six editable
  // by dragging its blocks around inside it; guarding only the source would let
  // day two be used as a doorway into day six.
  const allowance = await canGenerateDays(userActor(userId), itineraryId)
  assertDayWithinAllowance(sourceDay.dayNumber, allowance)
  assertDayWithinAllowance(targetDay.dayNumber, allowance)

  await db.itineraryBlock.update({
    where: { id: blockId },
    data: {
      dayId: targetDay.id,
      startMinute,
      endMinute,
      sortOrder: startMinute,
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.isLocked !== undefined ? { isLocked: input.isLocked } : {}),
      ...(input.transitMode !== undefined ? { transitMode: input.transitMode } : {}),
      // A block a person has moved stops being our estimate, whatever it was
      // before — otherwise the next resync would delete their edit.
      isEstimate: false,
    },
    select: { id: true },
  })

  await syncTransitBlocks(sourceDay.id, itinerary.transportPreference)
  if (targetDay.id !== sourceDay.id) {
    await syncTransitBlocks(targetDay.id, itinerary.transportPreference)
  }

  return { itinerary: await getItinerary(userId, itineraryId), blockId }
}

export async function removeBlock(
  userId: string,
  itineraryId: string,
  blockId: string
): Promise<ItineraryView> {
  const itinerary = await loadOwnedItinerary(userId, itineraryId)

  const day = itinerary.days.find((candidate) =>
    candidate.blocks.some((block) => block.id === blockId)
  )
  if (day === undefined) throw notFound('That block is not part of this itinerary.')

  await db.itineraryBlock.delete({ where: { id: blockId } })
  await syncTransitBlocks(day.id, itinerary.transportPreference)

  return getItinerary(userId, itineraryId)
}

// ── Saving ──────────────────────────────────────────────────────────────────

export interface SaveResult {
  itinerary: ItineraryView
  /** What is left of the allowance afterwards. Null on an uncapped plan. */
  remaining: number | null
}

/**
 * Keep this itinerary.
 *
 * The entitlement decides, and a refusal is thrown rather than returned: unlike
 * day generation there is no partial success to narrate — either the trip is
 * kept or it is not.
 *
 * The count and the write are one atomic claim inside `claimSaveSlot`, and that
 * is the whole point of this function being three lines long. What it used to do
 * was ask `canSaveItinerary` — which COUNTS — and then issue an unconditional
 * update, with nothing holding the two together. Creation is uncapped, so a FREE
 * account could make eight DRAFTs and fire eight concurrent saves: all eight
 * counted 0, all eight passed a cap of 3, all eight were kept.
 *
 * `loadOwnedItinerary` still runs first, and only for its 404: ownership must be
 * answered as "no such itinerary" before anything else happens, so an id that
 * belongs to a stranger cannot be probed by the shape of the refusal it gets.
 */
export async function saveItinerary(userId: string, itineraryId: string): Promise<SaveResult> {
  await loadOwnedItinerary(userId, itineraryId)

  const { decision } = await claimSaveSlot(userId, itineraryId)

  if (!decision.allowed) throw entitlementRefused(decision.refusal)

  return { itinerary: await getItinerary(userId, itineraryId), remaining: decision.remaining }
}
