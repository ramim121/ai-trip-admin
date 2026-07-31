import { describe, expect, it } from 'vitest'
import type { GeoPoint, OpeningWindow } from '@/server/modules/catalog/service'
import {
  DEFAULT_TRANSFER_MINUTES,
  blocksOverlap,
  detectActivityOverlaps,
  detectConflicts,
  detectOpeningHoursIssues,
  detectTravelGaps,
  estimateTravelMinutes,
  hasHardConflict,
  planTransitInsertions,
  transitModeFor,
  type TimelineBlock,
} from './conflicts'

/**
 * The rules a traveller actually feels.
 *
 * Two of these fail in ways nobody notices until the trip: a day that cannot be
 * walked reads perfectly well on a screen, and a museum shut on Fridays looks
 * exactly like one that is open. So the assertions are about the *specific*
 * finding — which blocks, which severity, how many minutes short — rather than
 * merely that something was returned.
 *
 * The third rule is that we never rearrange anybody's day. That one is asserted
 * negatively, by pinning what these functions leave alone.
 */

/** Cox's Bazar beachfront. */
const BEACH: GeoPoint = { latitude: 21.4272, longitude: 92.0058 }
/** ~300 m up the same road — walkable by anyone's reckoning. */
const NEXT_DOOR: GeoPoint = { latitude: 21.43, longitude: 92.0058 }
/** ~4.8 km north — a drive, not a stroll. */
const ACROSS_TOWN: GeoPoint = { latitude: 21.47, longitude: 92.01 }

function block(overrides: Partial<TimelineBlock> & Pick<TimelineBlock, 'id'>): TimelineBlock {
  return {
    kind: 'ACTIVITY',
    activityId: `activity-${overrides.id}`,
    title: `Block ${overrides.id}`,
    startMinute: 9 * 60,
    endMinute: 11 * 60,
    ...overrides,
  }
}

/** 09:00–17:00 on the given weekdays. */
function openOn(days: number[]): OpeningWindow[] {
  return days.map((dayOfWeek) => ({ dayOfWeek, opensMinute: 540, closesMinute: 1020 }))
}

describe('blocksOverlap', () => {
  it('treats the interval as half-open, so back-to-back blocks are not a clash', () => {
    // The most common shape in a real day. Getting this wrong would flag almost
    // every well-built itinerary.
    const morning = block({ id: 'a', startMinute: 540, endMinute: 720 })
    const afternoon = block({ id: 'b', startMinute: 720, endMinute: 900 })

    expect(blocksOverlap(morning, afternoon)).toBe(false)
  })

  it('is symmetric', () => {
    const a = block({ id: 'a', startMinute: 540, endMinute: 720 })
    const b = block({ id: 'b', startMinute: 600, endMinute: 900 })

    expect(blocksOverlap(a, b)).toBe(true)
    expect(blocksOverlap(b, a)).toBe(true)
  })

  it('counts containment as overlap', () => {
    const allDay = block({ id: 'a', startMinute: 540, endMinute: 1080 })
    const inside = block({ id: 'b', startMinute: 600, endMinute: 660 })

    expect(blocksOverlap(allDay, inside)).toBe(true)
  })
})

describe('detectActivityOverlaps', () => {
  it('reports two overlapping activities as one HARD conflict', () => {
    const conflicts = detectActivityOverlaps([
      block({ id: 'a', startMinute: 540, endMinute: 720 }),
      block({ id: 'b', startMinute: 660, endMinute: 900 }),
    ])

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].code).toBe('ACTIVITY_OVERLAP')
    expect(conflicts[0].severity).toBe('HARD')
    expect(conflicts[0].blockIds).toEqual(['a', 'b'])
    // 11:00 to 12:00 is shared.
    expect(conflicts[0].minutes).toBe(60)
  })

  it('names the blocks in timeline order regardless of input order', () => {
    const conflicts = detectActivityOverlaps([
      block({ id: 'later', startMinute: 660, endMinute: 900 }),
      block({ id: 'earlier', startMinute: 540, endMinute: 720 }),
    ])

    expect(conflicts[0].blockIds).toEqual(['earlier', 'later'])
  })

  it('reports every offending pair when three activities pile up', () => {
    const conflicts = detectActivityOverlaps([
      block({ id: 'a', startMinute: 540, endMinute: 900 }),
      block({ id: 'b', startMinute: 600, endMinute: 700 }),
      block({ id: 'c', startMinute: 650, endMinute: 800 }),
    ])

    expect(conflicts.map((conflict) => conflict.blockIds)).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ])
  })

  it('ignores a MEAL sitting inside an activity — lunch on a boat is not a clash', () => {
    const conflicts = detectActivityOverlaps([
      block({ id: 'cruise', startMinute: 540, endMinute: 900 }),
      block({ id: 'lunch', kind: 'MEAL', activityId: null, startMinute: 720, endMinute: 780 }),
    ])

    expect(conflicts).toEqual([])
  })

  it('ignores an auto-inserted TRANSIT block that touches its neighbours', () => {
    const conflicts = detectActivityOverlaps([
      block({ id: 'a', startMinute: 540, endMinute: 660 }),
      block({
        id: 'transfer',
        kind: 'TRANSIT',
        activityId: null,
        startMinute: 660,
        endMinute: 690,
        isEstimate: true,
      }),
      block({ id: 'b', startMinute: 690, endMinute: 810 }),
    ])

    expect(conflicts).toEqual([])
  })
})

describe('estimateTravelMinutes', () => {
  it('walks a short hop even when the traveller said they would take a car', () => {
    const estimate = estimateTravelMinutes(BEACH, NEXT_DOOR, 'PRIVATE_CAR')

    expect(estimate.mode).toBe('WALK')
    expect(estimate.isEstimate).toBe(true)
    expect(estimate.distanceKm).toBeLessThan(1)
  })

  it('does not walk a short hop for someone who brought their own car', () => {
    // They still have to fetch it and park it again, so the car wins.
    expect(transitModeFor('SELF_DRIVE', 0.3)).toBe('CAR')
    expect(transitModeFor('PRIVATE_CAR', 0.3)).toBe('WALK')
  })

  it('costs a longer leg more than a shorter one', () => {
    const near = estimateTravelMinutes(BEACH, NEXT_DOOR, 'PRIVATE_CAR')
    const far = estimateTravelMinutes(BEACH, ACROSS_TOWN, 'PRIVATE_CAR')

    expect(far.mode).toBe('CAR')
    expect(far.minutes).toBeGreaterThan(near.minutes)
  })

  it('assumes a generous transfer rather than zero when a coordinate is missing', () => {
    // Zero would be a claim that teleportation is available — the claim that
    // produces a plan whose second activity is already missed on arrival.
    const estimate = estimateTravelMinutes(BEACH, null, 'MIXED')

    expect(estimate.minutes).toBe(DEFAULT_TRANSFER_MINUTES)
    expect(estimate.distanceKm).toBeNull()
    expect(estimate.isEstimate).toBe(true)
  })

  it('is symmetric', () => {
    const there = estimateTravelMinutes(BEACH, ACROSS_TOWN, 'PUBLIC_TRANSIT')
    const back = estimateTravelMinutes(ACROSS_TOWN, BEACH, 'PUBLIC_TRANSIT')

    expect(there.minutes).toBe(back.minutes)
  })
})

describe('detectTravelGaps', () => {
  it('warns when two activities are closer together than the drive between them', () => {
    const conflicts = detectTravelGaps(
      [
        block({ id: 'a', startMinute: 540, endMinute: 660, location: BEACH }),
        block({ id: 'b', startMinute: 665, endMinute: 800, location: ACROSS_TOWN }),
      ],
      'PRIVATE_CAR'
    )

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].code).toBe('INSUFFICIENT_TRAVEL_TIME')
    expect(conflicts[0].severity).toBe('WARNING')
    expect(conflicts[0].blockIds).toEqual(['a', 'b'])

    const estimate = estimateTravelMinutes(BEACH, ACROSS_TOWN, 'PRIVATE_CAR')
    expect(conflicts[0].minutes).toBe(estimate.minutes - 5)
  })

  it('stays quiet when there is enough time', () => {
    const conflicts = detectTravelGaps(
      [
        block({ id: 'a', startMinute: 540, endMinute: 660, location: BEACH }),
        block({ id: 'b', startMinute: 780, endMinute: 900, location: ACROSS_TOWN }),
      ],
      'PRIVATE_CAR'
    )

    expect(conflicts).toEqual([])
  })

  it('still warns once a truncated transfer has been drawn into the gap', () => {
    // Inserting a transit block does not create time. If the warning vanished
    // the moment we drew our own block, the day would look solved and still be
    // impossible.
    const blocks = [
      block({ id: 'a', startMinute: 540, endMinute: 660, location: BEACH }),
      block({
        id: 'transfer',
        kind: 'TRANSIT',
        activityId: null,
        startMinute: 660,
        endMinute: 665,
        isEstimate: true,
      }),
      block({ id: 'b', startMinute: 665, endMinute: 800, location: ACROSS_TOWN }),
    ]

    const conflicts = detectTravelGaps(blocks, 'PRIVATE_CAR')

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].blockIds).toEqual(['a', 'b'])
  })

  it('does not invent a travel warning around a meal, whose location we do not know', () => {
    const conflicts = detectTravelGaps(
      [
        block({ id: 'a', startMinute: 540, endMinute: 660, location: BEACH }),
        block({ id: 'lunch', kind: 'MEAL', activityId: null, startMinute: 660, endMinute: 720 }),
      ],
      'PRIVATE_CAR'
    )

    expect(conflicts).toEqual([])
  })

  it('does not double-report an overlap as a travel shortfall', () => {
    const blocks = [
      block({ id: 'a', startMinute: 540, endMinute: 720, location: BEACH }),
      block({ id: 'b', startMinute: 660, endMinute: 900, location: ACROSS_TOWN }),
    ]

    expect(detectTravelGaps(blocks, 'PRIVATE_CAR')).toEqual([])
    expect(detectActivityOverlaps(blocks)).toHaveLength(1)
  })
})

describe('detectOpeningHoursIssues', () => {
  const MONDAY = 1
  const FRIDAY = 5

  it('warns when the activity is shut that whole day', () => {
    const conflicts = detectOpeningHoursIssues(
      [block({ id: 'museum', startMinute: 600, endMinute: 720, openingHours: openOn([MONDAY]) })],
      FRIDAY
    )

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].code).toBe('OUTSIDE_OPENING_HOURS')
    expect(conflicts[0].severity).toBe('WARNING')
    expect(conflicts[0].blockIds).toEqual(['museum'])
    expect(conflicts[0].message).toContain('closed that day')
  })

  it('warns when the block starts before the gate opens', () => {
    // Containment, not overlap: arriving twenty minutes early is a locked gate.
    const conflicts = detectOpeningHoursIssues(
      [block({ id: 'museum', startMinute: 520, endMinute: 700, openingHours: openOn([MONDAY]) })],
      MONDAY
    )

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].message).toContain('09:00')
  })

  it('accepts a block entirely inside the window', () => {
    const conflicts = detectOpeningHoursIssues(
      [block({ id: 'museum', startMinute: 600, endMinute: 720, openingHours: openOn([MONDAY]) })],
      MONDAY
    )

    expect(conflicts).toEqual([])
  })

  it('treats an activity with no recorded hours as always open', () => {
    // The schema convention: no rows at all means open access. Reading it the
    // other way would delete every public beach from every plan.
    const conflicts = detectOpeningHoursIssues(
      [block({ id: 'beach', startMinute: 300, endMinute: 420, openingHours: [] })],
      FRIDAY
    )

    expect(conflicts).toEqual([])
  })

  it('says nothing when hours were never looked up', () => {
    const conflicts = detectOpeningHoursIssues([block({ id: 'unknown' })], FRIDAY)

    expect(conflicts).toEqual([])
  })

  it('says nothing when the trip has no dates yet', () => {
    // A warning that changes meaning the moment they pick their dates is worse
    // than no warning.
    const conflicts = detectOpeningHoursIssues(
      [block({ id: 'museum', startMinute: 600, endMinute: 720, openingHours: openOn([MONDAY]) })],
      null
    )

    expect(conflicts).toEqual([])
  })
})

describe('detectConflicts', () => {
  it('returns hard conflicts before warnings', () => {
    const conflicts = detectConflicts({
      blocks: [
        block({
          id: 'a',
          startMinute: 540,
          endMinute: 720,
          location: BEACH,
          openingHours: openOn([1]),
        }),
        block({ id: 'b', startMinute: 660, endMinute: 900, location: ACROSS_TOWN }),
      ],
      transportPreference: 'PRIVATE_CAR',
      dayOfWeek: 5,
    })

    expect(conflicts[0].severity).toBe('HARD')
    expect(hasHardConflict(conflicts)).toBe(true)
    expect(conflicts.map((conflict) => conflict.code)).toContain('OUTSIDE_OPENING_HOURS')
  })

  it('finds nothing wrong with a well-built day', () => {
    const conflicts = detectConflicts({
      blocks: [
        block({
          id: 'a',
          startMinute: 600,
          endMinute: 720,
          location: BEACH,
          openingHours: openOn([1]),
        }),
        block({
          id: 'transfer',
          kind: 'TRANSIT',
          activityId: null,
          startMinute: 720,
          endMinute: 750,
          isEstimate: true,
        }),
        block({
          id: 'b',
          startMinute: 780,
          endMinute: 900,
          location: ACROSS_TOWN,
          openingHours: openOn([1]),
        }),
      ],
      transportPreference: 'PRIVATE_CAR',
      dayOfWeek: 1,
    })

    expect(conflicts).toEqual([])
  })
})

describe('planTransitInsertions', () => {
  it('fills the gap between two consecutive activities', () => {
    const insertions = planTransitInsertions(
      [
        block({ id: 'a', startMinute: 540, endMinute: 660, location: BEACH, title: 'Beach walk' }),
        block({ id: 'b', startMinute: 780, endMinute: 900, location: ACROSS_TOWN, title: 'Temple' }),
      ],
      'PRIVATE_CAR'
    )

    const estimate = estimateTravelMinutes(BEACH, ACROSS_TOWN, 'PRIVATE_CAR')

    expect(insertions).toHaveLength(1)
    expect(insertions[0]).toMatchObject({
      fromBlockId: 'a',
      toBlockId: 'b',
      startMinute: 660,
      endMinute: 660 + estimate.minutes,
      mode: 'CAR',
      truncated: false,
      title: 'Travel to Temple',
    })
  })

  it('clips the transfer to the gap rather than pushing the next activity later', () => {
    // The whole doctrine in one assertion: we do not move a block a traveller
    // placed, not even to make our own estimate fit.
    const insertions = planTransitInsertions(
      [
        block({ id: 'a', startMinute: 540, endMinute: 660, location: BEACH }),
        block({ id: 'b', startMinute: 670, endMinute: 800, location: ACROSS_TOWN }),
      ],
      'PRIVATE_CAR'
    )

    expect(insertions).toHaveLength(1)
    expect(insertions[0].startMinute).toBe(660)
    expect(insertions[0].endMinute).toBe(670)
    expect(insertions[0].truncated).toBe(true)
    expect(insertions[0].estimatedMinutes).toBeGreaterThan(10)
  })

  it('inserts nothing when the two activities already touch', () => {
    const insertions = planTransitInsertions(
      [
        block({ id: 'a', startMinute: 540, endMinute: 660, location: BEACH }),
        block({ id: 'b', startMinute: 660, endMinute: 800, location: ACROSS_TOWN }),
      ],
      'PRIVATE_CAR'
    )

    expect(insertions).toEqual([])
  })

  it('inserts nothing when the two activities overlap', () => {
    const insertions = planTransitInsertions(
      [
        block({ id: 'a', startMinute: 540, endMinute: 720, location: BEACH }),
        block({ id: 'b', startMinute: 660, endMinute: 800, location: ACROSS_TOWN }),
      ],
      'PRIVATE_CAR'
    )

    expect(insertions).toEqual([])
  })

  it('is idempotent — a second run over the inserted day proposes nothing', () => {
    const day = [
      block({ id: 'a', startMinute: 540, endMinute: 660, location: BEACH }),
      block({ id: 'b', startMinute: 780, endMinute: 900, location: ACROSS_TOWN }),
    ]

    const first = planTransitInsertions(day, 'PRIVATE_CAR')
    const withTransit: TimelineBlock[] = [
      ...day,
      ...first.map((insertion, index) => ({
        id: `transit-${index}`,
        kind: 'TRANSIT' as const,
        activityId: null,
        title: insertion.title,
        startMinute: insertion.startMinute,
        endMinute: insertion.endMinute,
        isEstimate: true,
      })),
    ]

    expect(planTransitInsertions(withTransit, 'PRIVATE_CAR')).toEqual([])
  })

  it('leaves a transfer the traveller wrote themselves alone', () => {
    const insertions = planTransitInsertions(
      [
        block({ id: 'a', startMinute: 540, endMinute: 660, location: BEACH }),
        block({
          id: 'their-ferry',
          kind: 'TRANSIT',
          activityId: null,
          title: 'Ferry we booked',
          startMinute: 690,
          endMinute: 750,
          isEstimate: false,
        }),
        block({ id: 'b', startMinute: 780, endMinute: 900, location: ACROSS_TOWN }),
      ],
      'PRIVATE_CAR'
    )

    expect(insertions).toEqual([])
  })

  it('does not insert around a meal, whose location it cannot know', () => {
    const insertions = planTransitInsertions(
      [
        block({ id: 'a', startMinute: 540, endMinute: 660, location: BEACH }),
        block({ id: 'lunch', kind: 'MEAL', activityId: null, startMinute: 720, endMinute: 780 }),
      ],
      'PRIVATE_CAR'
    )

    expect(insertions).toEqual([])
  })

  it('uses the flat transfer when an activity has no coordinates', () => {
    const insertions = planTransitInsertions(
      [
        block({ id: 'a', startMinute: 540, endMinute: 660, location: BEACH }),
        block({ id: 'b', startMinute: 780, endMinute: 900, location: null }),
      ],
      'MIXED'
    )

    expect(insertions).toHaveLength(1)
    expect(insertions[0].estimatedMinutes).toBe(DEFAULT_TRANSFER_MINUTES)
    expect(insertions[0].distanceKm).toBeNull()
  })
})
