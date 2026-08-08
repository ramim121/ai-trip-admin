import type { DaySlot, JourneyItemType } from '@/generated/prisma/enums'

/**
 * When two things on one day cannot both happen — spec §5.10.
 *
 * WHY THIS IS STRICTER THAN THE CURATED PLANNER'S CHECK. There, a clash is
 * advice: the traveller is arranging their own day and may know something we do
 * not. Here the plan becomes a QUOTATION somebody prices by hand, and an overlap
 * sent for pricing wastes an ops cycle and comes back wrong. So overlaps block
 * the quotation request — and deliberately not saving, because a traveller
 * mid-rearrange must never reach a state where their work will not persist.
 *
 * THE HARD PART IS THAT MOST ITEMS HAVE NO TIME. Humans plan in day-parts, so
 * "Morning" is the normal precision and "09:00" is the exception. Two items in
 * one slot without times are not automatically a clash — a coffee and a museum
 * both fit a morning. They clash when their durations cannot both fit.
 */

/**
 * When each day-part runs.
 *
 * Chosen to tile the waking day without gaps, so a plan cannot land between
 * Morning and Afternoon. The boundaries are conventional rather than clever: a
 * traveller reading "Afternoon" is thinking "after lunch, before dinner" and not
 * about a specific clock.
 */
export const SLOT_RANGES: Record<DaySlot, { start: number; end: number }> = {
  MORNING: { start: 8 * 60, end: 12 * 60 },
  AFTERNOON: { start: 12 * 60, end: 17 * 60 },
  EVENING: { start: 17 * 60, end: 22 * 60 },
}

export const SLOT_ORDER: readonly DaySlot[] = ['MORNING', 'AFTERNOON', 'EVENING']

/**
 * Kinds that never clash with anything.
 *
 * A hotel is where you sleep rather than a thing occupying an afternoon:
 * checking into one does not stop you going out. Transfers are exempt for a
 * different reason — an overnight bus legitimately spans slots and days, and
 * flagging it against everything else would bury the real conflicts in noise.
 */
const EXEMPT_TYPES: ReadonlySet<JourneyItemType> = new Set(['STAY', 'TRANSFER'])

export interface ConflictInput {
  id: string
  dayNumber: number
  slot: DaySlot
  /** Minutes from midnight, when the traveller set an exact time. */
  startMinute: number | null
  durationMin: number | null
  type: JourneyItemType
  title: string
}

export interface TimeRange {
  start: number
  end: number
}

export interface Conflict {
  dayNumber: number
  itemIds: string[]
  /** The overlapping window, so a banner can name it. */
  overlap: TimeRange
  /** One sentence a traveller can act on, naming both items and their times. */
  message: string
}

/**
 * The window an item actually occupies, or null when it floats.
 *
 * An explicit start wins, and the duration extends from it. Without one the item
 * is anywhere within its slot, which is not a range that can be compared — so
 * callers distinguish the two cases rather than this pretending a floating item
 * has a fixed position.
 */
export function effectiveRange(item: ConflictInput): TimeRange | null {
  if (item.startMinute === null) return null

  const slot = SLOT_RANGES[item.slot]
  const duration = item.durationMin ?? Math.max(60, slot.end - item.startMinute)

  return { start: item.startMinute, end: item.startMinute + duration }
}

function overlapOf(a: TimeRange, b: TimeRange): TimeRange | null {
  const start = Math.max(a.start, b.start)
  const end = Math.min(a.end, b.end)

  // Touching is not overlapping: one thing ending as another begins is a plan,
  // not a clash. Without this, every back-to-back pair would be an error.
  return end > start ? { start, end } : null
}

/** `09:30` — minutes past midnight, as a clock a traveller reads. */
export function formatMinute(minute: number): string {
  const hour = Math.floor(minute / 60) % 24
  const rest = minute % 60
  return `${String(hour).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function describeRange(range: TimeRange): string {
  return `${formatMinute(range.start)}–${formatMinute(range.end)}`
}

/**
 * Which slots an item claims.
 *
 * A TIMED ITEM CLAIMS EVERY SLOT IT RUNS THROUGH — the §5.10 special case that
 * matters most. A 05:00–16:00 island tour occupies Morning AND Afternoon, and
 * blocking both the moment it lands is what stops a conflict being created at
 * all. Preventing one beats resolving one, so the interface greys those slots
 * out rather than letting somebody drop a spa into them.
 */
export function claimedSlots(item: ConflictInput): DaySlot[] {
  const range = effectiveRange(item)
  if (range === null) return [item.slot]

  const claimed = SLOT_ORDER.filter((slot) => overlapOf(range, SLOT_RANGES[slot]) !== null)

  // A tour starting at 05:00 overlaps no slot window, since the day-parts begin
  // at 08:00 — but it plainly occupies the morning it starts in. Falling back to
  // the declared slot keeps an early departure from claiming nothing.
  return claimed.length > 0 ? claimed : [item.slot]
}

/**
 * Every conflict on a plan.
 *
 * Two rules, deliberately different, because the two situations are different:
 *
 *   BOTH TIMED — a real overlap of real clock ranges. Unambiguous.
 *   NEITHER TIMED — a clash only when the durations cannot fit the slot
 *     together. Two 90-minute things in a four-hour morning are fine; a
 *     five-hour tour and a two-hour lunch are not, in whatever order.
 *
 * ONE TIMED AND ONE NOT is treated as fine. The untimed item can move within its
 * slot, so unless the timed one fills that slot entirely there is somewhere for
 * it to go — and flagging it would mean somebody who set a single exact time
 * suddenly sees errors against everything near it.
 */
export function detectConflicts(items: readonly ConflictInput[]): Conflict[] {
  const conflicts: Conflict[] = []
  const relevant = items.filter((item) => !EXEMPT_TYPES.has(item.type))

  const byDay = new Map<number, ConflictInput[]>()
  for (const item of relevant) {
    const day = byDay.get(item.dayNumber)
    if (day === undefined) byDay.set(item.dayNumber, [item])
    else day.push(item)
  }

  for (const [dayNumber, dayItems] of byDay) {
    // ── Timed against timed ────────────────────────────────────────────────
    for (let i = 0; i < dayItems.length; i += 1) {
      for (let j = i + 1; j < dayItems.length; j += 1) {
        const a = dayItems[i]
        const b = dayItems[j]
        if (a === undefined || b === undefined) continue

        const rangeA = effectiveRange(a)
        const rangeB = effectiveRange(b)
        if (rangeA === null || rangeB === null) continue

        const overlap = overlapOf(rangeA, rangeB)
        if (overlap === null) continue

        conflicts.push({
          dayNumber,
          itemIds: [a.id, b.id],
          overlap,
          message: `${a.title} (${describeRange(rangeA)}) overlaps ${b.title} (${describeRange(rangeB)})`,
        })
      }
    }

    // ── Untimed, per slot ──────────────────────────────────────────────────
    for (const slot of SLOT_ORDER) {
      const untimed = dayItems.filter((item) => item.slot === slot && item.startMinute === null)
      if (untimed.length < 2) continue

      const slotRange = SLOT_RANGES[slot]
      const capacity = slotRange.end - slotRange.start

      // A missing duration counts as an hour rather than as nothing. Treating an
      // unknown as free is how a day silently fills past what fits in it.
      const needed = untimed.reduce((total, item) => total + (item.durationMin ?? 60), 0)
      if (needed <= capacity) continue

      conflicts.push({
        dayNumber,
        itemIds: untimed.map((item) => item.id),
        overlap: slotRange,
        message: `${slot.toLowerCase()} on day ${dayNumber} holds about ${Math.round(needed / 60)} hours of plans in a ${Math.round(capacity / 60)}-hour window`,
      })
    }
  }

  return conflicts
}

export interface Validation {
  status: 'valid' | 'conflicts'
  conflicts: Conflict[]
}

export function validate(items: readonly ConflictInput[]): Validation {
  const conflicts = detectConflicts(items)
  return { status: conflicts.length === 0 ? 'valid' : 'conflicts', conflicts }
}

export interface Resolution {
  label: string
  /** What the interface does, as one tap. */
  action:
    | { kind: 'moveSlot'; itemId: string; slot: DaySlot }
    | { kind: 'moveDay'; itemId: string; dayNumber: number }
    | { kind: 'remove'; itemId: string }
}

/**
 * One-tap ways out of a conflict.
 *
 * COMPUTED RATHER THAN ASKED OF THE MODEL. Which slots are free is arithmetic we
 * already hold, and a resolver needing a model round trip would be slow at
 * exactly the moment somebody is stuck. The chat can still be asked in words —
 * "move the spa to day 4" — and that path re-validates through this same
 * function.
 *
 * Offered moves are checked against what already occupies the target, so no
 * suggested fix creates the conflict it was meant to clear.
 */
export function resolutionsFor(
  conflict: Conflict,
  items: readonly ConflictInput[],
  totalDays: number
): Resolution[] {
  const resolutions: Resolution[] = []

  // The later item is the one to move. The first is usually the anchor the day
  // was built around — a tour departing at five in the morning is not the thing
  // anybody wants shuffled.
  const movableId = conflict.itemIds[conflict.itemIds.length - 1]
  const movable = items.find((item) => item.id === movableId)
  if (movable === undefined) return resolutions

  const sameDay = items.filter(
    (item) => item.dayNumber === conflict.dayNumber && item.id !== movable.id
  )
  const occupied = new Set(sameDay.flatMap(claimedSlots))

  for (const slot of SLOT_ORDER) {
    if (slot === movable.slot || occupied.has(slot)) continue
    resolutions.push({
      label: `Move ${movable.title} to ${slot.toLowerCase()}`,
      action: { kind: 'moveSlot', itemId: movable.id, slot },
    })
  }

  // The emptiest other day, so the suggestion is somewhere the item can actually
  // go — rather than tomorrow regardless of how full tomorrow already is.
  const load = new Map<number, number>()
  for (const item of items) load.set(item.dayNumber, (load.get(item.dayNumber) ?? 0) + 1)

  const quietest = Array.from({ length: totalDays }, (_, index) => index + 1)
    .filter((day) => day !== conflict.dayNumber)
    .sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0))[0]

  if (quietest !== undefined) {
    resolutions.push({
      label: `Move ${movable.title} to day ${quietest}`,
      action: { kind: 'moveDay', itemId: movable.id, dayNumber: quietest },
    })
  }

  resolutions.push({
    label: `Remove ${movable.title}`,
    action: { kind: 'remove', itemId: movable.id },
  })

  return resolutions
}
