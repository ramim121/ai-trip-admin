import { TransitMode, type TransportPreference } from '@/generated/prisma/enums'
import type { DayBlockKind } from '@/server/ai/schemas'
import {
  estimateMinutesForDistance,
  evaluateOpeningWindows,
  greatCircleKm,
  type GeoPoint,
  type OpeningWindow,
} from '@/server/modules/catalog/service'

/**
 * Whether a day can actually be walked.
 *
 * Every function here is pure: integers in, structured findings out, no database
 * and no clock. That is what makes the rules assertable — "two hours of activity
 * inside a one-hour opening window" is a claim worth a test, and a claim that
 * needs Postgres to check is a claim nobody checks.
 *
 * The other half of the design is what these functions deliberately do NOT do:
 * they never move a block. A planner that quietly reshuffles a traveller's
 * afternoon to resolve a clash produces a day nobody asked for and hides the
 * fact that something was wrong. So a conflict is *reported* — with the ids
 * involved and the size of the problem — and the traveller decides. The only
 * thing we place on our own initiative is a TRANSIT block into time that is
 * already empty, which moves nothing.
 *
 * Times are minutes from local midnight throughout. `endMinute` may exceed 1440
 * for a block running past midnight, so every comparison is plain integer
 * arithmetic with no timezone and no DST anywhere near it.
 *
 * The distance and opening-hours primitives come from `catalog/service.ts`
 * rather than being reimplemented, so the estimate a tool quotes to the model
 * and the estimate the timeline enforces can never drift apart.
 */

// ── The block, as this module needs it ──────────────────────────────────────

/**
 * Enough of a block to reason about, and no more.
 *
 * `location` and `openingHours` are hydrated by the caller from the catalog
 * rather than fetched here, which is what keeps this module pure and lets a test
 * describe an awkward day in six lines.
 */
export interface TimelineBlock {
  id: string
  kind: DayBlockKind
  activityId: string | null
  title: string
  startMinute: number
  /** Exclusive. A block ending at 600 and one starting at 600 do not overlap. */
  endMinute: number
  /** True when we computed this block rather than a person authoring it. */
  isEstimate?: boolean
  /** Where it happens, when we know. Null for a meal or a rest. */
  location?: GeoPoint | null
  /**
   * The activity's opening windows. An empty array means always open (an open
   * beach, a public viewpoint); `undefined` means we never looked them up.
   */
  openingHours?: readonly OpeningWindow[] | undefined
}

/** Chronological, with a stable tie-break so equal starts do not jitter. */
export function sortBlocks<T extends { startMinute: number; endMinute: number; id: string }>(
  blocks: readonly T[]
): T[] {
  return [...blocks].sort(
    (a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute || a.id.localeCompare(b.id)
  )
}

// ── Overlap ─────────────────────────────────────────────────────────────────

/**
 * Half-open intervals: `[start, end)`.
 *
 * The choice matters at exactly one point, and it is the common one — a block
 * ending at 12:00 and the next starting at 12:00 are back to back, not in
 * conflict. Treating the boundary as closed would flag most well-built days.
 */
export function blocksOverlap(
  a: Pick<TimelineBlock, 'startMinute' | 'endMinute'>,
  b: Pick<TimelineBlock, 'startMinute' | 'endMinute'>
): boolean {
  return a.startMinute < b.endMinute && b.startMinute < a.endMinute
}

/** Minutes two intervals share. Zero when they merely touch. */
export function overlapMinutes(
  a: Pick<TimelineBlock, 'startMinute' | 'endMinute'>,
  b: Pick<TimelineBlock, 'startMinute' | 'endMinute'>
): number {
  return Math.max(0, Math.min(a.endMinute, b.endMinute) - Math.max(a.startMinute, b.startMinute))
}

// ── Travel ──────────────────────────────────────────────────────────────────

/**
 * How a stated preference becomes a vehicle.
 *
 * MIXED is a taxi rather than a bus: "whatever is easiest" in Dhaka or Bangkok
 * is a ride-hail, and pricing a mixed day at bus speeds would build an itinerary
 * nobody can keep.
 */
export const TRANSPORT_MODES: Record<TransportPreference, TransitMode> = {
  PRIVATE_CAR: TransitMode.CAR,
  SELF_DRIVE: TransitMode.CAR,
  PUBLIC_TRANSIT: TransitMode.BUS,
  WALKING: TransitMode.WALK,
  MIXED: TransitMode.TAXI,
}

/** Below this, walking beats waiting for anything with wheels. */
export const WALKABLE_KM = 1.2

/**
 * What we assume when one of the two ends has no coordinates.
 *
 * Not zero. Zero is a claim that teleportation is available, and it is the claim
 * that produces a plan whose second activity is already missed on arrival. Thirty
 * minutes is deliberately generous: an unknown transfer should cost the plan
 * slack, not cost the traveller their booking.
 */
export const DEFAULT_TRANSFER_MINUTES = 30

export interface LegEstimate {
  minutes: number
  mode: TransitMode
  /** Null when either end has no coordinates. */
  distanceKm: number | null
  /**
   * Always true. Distance and an average speed, never a routed duration — and
   * every block built from one of these is stored with `isEstimate` set, so a
   * traveller can tell our arithmetic from their own knowledge of the road.
   */
  isEstimate: true
}

/**
 * Which vehicle actually gets used for a leg of this length.
 *
 * A short hop is walked whatever the stated preference — except by someone who
 * brought their own car, who still has to fetch it and park it again.
 */
export function transitModeFor(
  preference: TransportPreference,
  distanceKm: number | null
): TransitMode {
  const stated = TRANSPORT_MODES[preference] ?? TransitMode.TAXI
  if (distanceKm === null) return stated
  return distanceKm <= WALKABLE_KM && preference !== 'SELF_DRIVE' ? TransitMode.WALK : stated
}

/**
 * How long it takes to get from one block to the next.
 *
 * The arithmetic is `catalog/service.ts`'s — this only decides which two points
 * and which mode to hand it, and what to do when there are no points at all.
 */
export function estimateTravelMinutes(
  from: GeoPoint | null | undefined,
  to: GeoPoint | null | undefined,
  preference: TransportPreference
): LegEstimate {
  if (!from || !to) {
    return {
      minutes: DEFAULT_TRANSFER_MINUTES,
      mode: transitModeFor(preference, null),
      distanceKm: null,
      isEstimate: true,
    }
  }

  const distanceKm = greatCircleKm(from, to)
  const mode = transitModeFor(preference, distanceKm)

  return {
    minutes: estimateMinutesForDistance(distanceKm, mode),
    mode,
    distanceKm: Math.round(distanceKm * 10) / 10,
    isEstimate: true,
  }
}

/** 570 → "09:30". Past midnight wraps, so 1560 reads as "02:00". */
export function formatMinute(minute: number): string {
  const normalised = ((minute % 1440) + 1440) % 1440
  const hours = Math.floor(normalised / 60)
  const minutes = normalised % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

// ── Conflicts ───────────────────────────────────────────────────────────────

export const CONFLICT_CODES = [
  'ACTIVITY_OVERLAP',
  'INSUFFICIENT_TRAVEL_TIME',
  'OUTSIDE_OPENING_HOURS',
] as const
export type ConflictCode = (typeof CONFLICT_CODES)[number]

/**
 * HARD means the day is not physically possible as written. WARNING means it is
 * possible but probably not what they meant. The distinction belongs to the
 * client: a hard conflict earns a red band on the Gantt and blocks submission
 * for a quote; a warning earns a note the traveller may knowingly ignore.
 */
export type ConflictSeverity = 'HARD' | 'WARNING'

export interface TimelineConflict {
  code: ConflictCode
  severity: ConflictSeverity
  /** Every block involved, in timeline order. One id for opening hours, two otherwise. */
  blockIds: string[]
  /** Minutes of overlap, or of shortfall. Zero when the code carries no size. */
  minutes: number
  /** For a human. Wording is not part of the contract; `code` is. */
  message: string
}

/** Two ACTIVITY blocks occupying the same minutes. The one hard rule. */
export function detectActivityOverlaps(blocks: readonly TimelineBlock[]): TimelineConflict[] {
  const activities = sortBlocks(blocks).filter((block) => block.kind === 'ACTIVITY')
  const conflicts: TimelineConflict[] = []

  for (let i = 0; i < activities.length; i += 1) {
    for (let j = i + 1; j < activities.length; j += 1) {
      const earlier = activities[i]
      const later = activities[j]

      // Sorted by start, so once one block starts at or after this one ends,
      // every remaining block does too.
      if (later.startMinute >= earlier.endMinute) break

      conflicts.push({
        code: 'ACTIVITY_OVERLAP',
        severity: 'HARD',
        blockIds: [earlier.id, later.id],
        minutes: overlapMinutes(earlier, later),
        message: `"${earlier.title}" (${formatMinute(earlier.startMinute)}–${formatMinute(earlier.endMinute)}) and "${later.title}" (${formatMinute(later.startMinute)}–${formatMinute(later.endMinute)}) are booked at the same time.`,
      })
    }
  }

  return conflicts
}

/**
 * Not enough time between two activities to get from one to the other.
 *
 * Only ACTIVITY pairs are checked. A MEAL or a REST has no location — we do not
 * know where lunch is — so a travel warning around one would be a number we
 * invented, and a warning a traveller cannot act on is a warning they learn to
 * ignore, which costs us the ones that matter.
 *
 * TRANSIT blocks are removed before pairing rather than treated as stops: the
 * gap between two activities is the same wall-clock time whether or not a
 * transfer has already been drawn into it, so inserting one must not make the
 * warning disappear while the day stays just as impossible.
 */
export function detectTravelGaps(
  blocks: readonly TimelineBlock[],
  preference: TransportPreference
): TimelineConflict[] {
  const stops = sortBlocks(blocks).filter((block) => block.kind !== 'TRANSIT')
  const conflicts: TimelineConflict[] = []

  for (let i = 1; i < stops.length; i += 1) {
    const previous = stops[i - 1]
    const current = stops[i]

    if (previous.kind !== 'ACTIVITY' || current.kind !== 'ACTIVITY') continue

    // An overlap is already a hard conflict; reporting it again as a travel
    // shortfall would double-count one mistake and bury the worse finding.
    if (blocksOverlap(previous, current)) continue

    const gap = current.startMinute - previous.endMinute
    const estimate = estimateTravelMinutes(previous.location, current.location, preference)

    if (gap >= estimate.minutes) continue

    conflicts.push({
      code: 'INSUFFICIENT_TRAVEL_TIME',
      severity: 'WARNING',
      blockIds: [previous.id, current.id],
      minutes: estimate.minutes - gap,
      message: `Getting from "${previous.title}" to "${current.title}" takes about ${estimate.minutes} minutes, and there ${gap === 1 ? 'is' : 'are'} only ${gap} between them.`,
    })
  }

  return conflicts
}

/**
 * A block placed when its activity is shut.
 *
 * Skipped entirely when `dayOfWeek` is null: an itinerary with no start date has
 * no weekday to check against, and guessing one produces warnings that change
 * meaning the moment the traveller picks their dates.
 */
export function detectOpeningHoursIssues(
  blocks: readonly TimelineBlock[],
  dayOfWeek: number | null
): TimelineConflict[] {
  if (dayOfWeek === null) return []

  const conflicts: TimelineConflict[] = []

  for (const block of sortBlocks(blocks)) {
    if (block.kind !== 'ACTIVITY') continue

    const windows = block.openingHours
    // `undefined` means we never looked this activity's hours up; an empty array
    // means we did, and it is open access. Only the second is a fact.
    if (windows === undefined) continue

    const availability = evaluateOpeningWindows(
      windows,
      dayOfWeek,
      block.startMinute,
      block.endMinute
    )
    if (availability.isOpen) continue

    const hours =
      availability.reason === 'CLOSED_ON_DAY'
        ? 'closed that day'
        : `open ${availability.windowsOnDay
            .map((window) => `${formatMinute(window.opensMinute)}–${formatMinute(window.closesMinute)}`)
            .join(', ')} that day`

    conflicts.push({
      code: 'OUTSIDE_OPENING_HOURS',
      severity: 'WARNING',
      blockIds: [block.id],
      minutes: 0,
      message: `"${block.title}" is planned for ${formatMinute(block.startMinute)}–${formatMinute(block.endMinute)}, but it is ${hours}.`,
    })
  }

  return conflicts
}

export interface ConflictScan {
  blocks: readonly TimelineBlock[]
  transportPreference: TransportPreference
  /** 0 = Sunday … 6 = Saturday. Null when the day has no date yet. */
  dayOfWeek: number | null
}

/** Every rule, hardest first, so a client rendering the top item shows the worst. */
export function detectConflicts(scan: ConflictScan): TimelineConflict[] {
  return [
    ...detectActivityOverlaps(scan.blocks),
    ...detectTravelGaps(scan.blocks, scan.transportPreference),
    ...detectOpeningHoursIssues(scan.blocks, scan.dayOfWeek),
  ]
}

/** True when nothing found is worse than a warning. */
export function hasHardConflict(conflicts: readonly TimelineConflict[]): boolean {
  return conflicts.some((conflict) => conflict.severity === 'HARD')
}

// ── Transit insertion ───────────────────────────────────────────────────────

export interface TransitInsertion {
  fromBlockId: string
  toBlockId: string
  startMinute: number
  endMinute: number
  mode: TransitMode
  /** What the estimate said, before it was clipped to fit the gap. */
  estimatedMinutes: number
  distanceKm: number | null
  title: string
  /**
   * True when the gap was too small to hold the whole estimate. The block is
   * drawn at the length that fits and `detectTravelGaps` reports the shortfall
   * separately — clipping is how we avoid moving a block the traveller placed.
   */
  truncated: boolean
}

/**
 * Where a transfer belongs, given a day as it stands.
 *
 * Only *adjacent* ACTIVITY pairs qualify, and adjacency is measured on the full
 * sorted list — which is what makes this idempotent. Once a transit block sits
 * between two activities they are no longer adjacent, so running this again
 * proposes nothing. It is also why a traveller's own transfer is never
 * duplicated: their block occupies the same position ours would have.
 *
 * Nothing is ever inserted into a gap of zero or less. A day with no room for
 * the transfer is a day with a conflict, and the answer to a conflict is to
 * report it, not to shove somebody's afternoon later.
 */
export function planTransitInsertions(
  blocks: readonly TimelineBlock[],
  preference: TransportPreference
): TransitInsertion[] {
  const ordered = sortBlocks(blocks)
  const insertions: TransitInsertion[] = []

  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]
    const current = ordered[i]

    if (previous.kind !== 'ACTIVITY' || current.kind !== 'ACTIVITY') continue

    const gap = current.startMinute - previous.endMinute
    if (gap <= 0) continue

    const estimate = estimateTravelMinutes(previous.location, current.location, preference)
    const minutes = Math.min(estimate.minutes, gap)
    if (minutes <= 0) continue

    insertions.push({
      fromBlockId: previous.id,
      toBlockId: current.id,
      startMinute: previous.endMinute,
      endMinute: previous.endMinute + minutes,
      mode: estimate.mode,
      estimatedMinutes: estimate.minutes,
      distanceKm: estimate.distanceKm,
      title: `Travel to ${current.title}`,
      truncated: estimate.minutes > gap,
    })
  }

  return insertions
}
