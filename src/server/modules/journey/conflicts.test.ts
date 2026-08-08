import { describe, expect, it } from 'vitest'
import {
  claimedSlots,
  detectConflicts,
  effectiveRange,
  resolutionsFor,
  validate,
  type ConflictInput,
} from './conflicts'

/**
 * The spec's §5.10 rules, pinned.
 *
 * Worth real tests because the rules are subtle in a way that reads as arbitrary
 * until written down: touching is not overlapping, a hotel never clashes, two
 * untimed things in one slot are fine until their durations stop fitting, and an
 * all-day tour claims two slots so a conflict cannot be created in the first
 * place.
 *
 * The scenario throughout is the spec's own: a Krabi island tour running
 * 05:00–16:00 against a spa at 14:00.
 */

function item(overrides: Partial<ConflictInput> & { id: string }): ConflictInput {
  return {
    dayNumber: 1,
    slot: 'MORNING',
    startMinute: null,
    durationMin: null,
    type: 'ACTIVITY',
    title: overrides.id,
    ...overrides,
  }
}

describe('effectiveRange', () => {
  it('is null for an item with no explicit time — it floats within its slot', () => {
    expect(effectiveRange(item({ id: 'a' }))).toBeNull()
  })

  it('runs from the explicit start for the stated duration', () => {
    expect(effectiveRange(item({ id: 'a', startMinute: 5 * 60, durationMin: 660 }))).toEqual({
      start: 300,
      end: 960,
    })
  })

  it('falls back to the rest of the slot when a timed item has no duration', () => {
    // 10:00 in a morning ending at 12:00 is two hours, not zero. A zero-length
    // item would collide with nothing and quietly disable the whole check.
    expect(effectiveRange(item({ id: 'a', slot: 'MORNING', startMinute: 10 * 60 }))).toEqual({
      start: 600,
      end: 720,
    })
  })
})

describe('claimedSlots', () => {
  it('claims only its own slot when the item floats', () => {
    expect(claimedSlots(item({ id: 'a', slot: 'AFTERNOON' }))).toEqual(['AFTERNOON'])
  })

  it('claims morning AND afternoon for an all-day tour — the §5.10 special case', () => {
    const tour = item({ id: 'tour', slot: 'MORNING', startMinute: 5 * 60, durationMin: 660 })
    expect(claimedSlots(tour)).toEqual(['MORNING', 'AFTERNOON'])
  })

  it('still claims its declared slot when it starts before the day-parts begin', () => {
    // 05:00–07:00 overlaps no slot window, since morning starts at 08:00. It is
    // plainly a morning item, and claiming nothing would let something else be
    // dropped straight on top of it.
    const early = item({ id: 'early', slot: 'MORNING', startMinute: 5 * 60, durationMin: 120 })
    expect(claimedSlots(early)).toEqual(['MORNING'])
  })
})

describe('detectConflicts — timed against timed', () => {
  it('flags the island tour against the spa, and names both times', () => {
    const conflicts = detectConflicts([
      item({ id: 'tour', title: 'Island tour', startMinute: 5 * 60, durationMin: 660 }),
      item({ id: 'spa', title: 'Spa', slot: 'AFTERNOON', startMinute: 14 * 60, durationMin: 120 }),
    ])

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.itemIds).toEqual(['tour', 'spa'])
    expect(conflicts[0]?.overlap).toEqual({ start: 840, end: 960 })
    expect(conflicts[0]?.message).toBe('Island tour (05:00–16:00) overlaps Spa (14:00–16:00)')
  })

  it('does not flag back-to-back items — touching is not overlapping', () => {
    expect(
      detectConflicts([
        item({ id: 'a', startMinute: 9 * 60, durationMin: 120 }),
        item({ id: 'b', startMinute: 11 * 60, durationMin: 60 }),
      ])
    ).toEqual([])
  })

  it('does not flag items on different days', () => {
    expect(
      detectConflicts([
        item({ id: 'a', dayNumber: 1, startMinute: 9 * 60, durationMin: 240 }),
        item({ id: 'b', dayNumber: 2, startMinute: 9 * 60, durationMin: 240 }),
      ])
    ).toEqual([])
  })
})

describe('detectConflicts — exemptions', () => {
  it('never flags a stay: checking into a hotel does not stop you going out', () => {
    expect(
      detectConflicts([
        item({ id: 'hotel', type: 'STAY', startMinute: 14 * 60, durationMin: 600 }),
        item({ id: 'spa', type: 'ACTIVITY', startMinute: 15 * 60, durationMin: 120 }),
      ])
    ).toEqual([])
  })

  it('never flags a transfer: an overnight bus legitimately spans everything', () => {
    expect(
      detectConflicts([
        item({ id: 'bus', type: 'TRANSFER', startMinute: 60, durationMin: 600 }),
        item({ id: 'tour', type: 'ACTIVITY', startMinute: 9 * 60, durationMin: 120 }),
      ])
    ).toEqual([])
  })
})

describe('detectConflicts — untimed in one slot', () => {
  it('allows two short things in one morning', () => {
    // 90 + 90 in a four-hour window: the ordinary case, and it must stay quiet
    // or the whole day-part model becomes unusable.
    expect(
      detectConflicts([item({ id: 'a', durationMin: 90 }), item({ id: 'b', durationMin: 90 })])
    ).toEqual([])
  })

  it('flags a morning holding more hours than a morning has', () => {
    const conflicts = detectConflicts([
      item({ id: 'a', title: 'Long tour', durationMin: 300 }),
      item({ id: 'b', title: 'Lunch', durationMin: 120 }),
    ])

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.itemIds).toEqual(['a', 'b'])
    expect(conflicts[0]?.message).toContain('7 hours of plans in a 4-hour window')
  })

  it('counts a missing duration as an hour rather than as nothing', () => {
    // Five unknowns in a four-hour morning. Treating unknown as free is how a
    // day silently fills past what fits in it.
    expect(
      detectConflicts([
        item({ id: 'a' }),
        item({ id: 'b' }),
        item({ id: 'c' }),
        item({ id: 'd' }),
        item({ id: 'e' }),
      ])
    ).toHaveLength(1)
  })

  it('does not flag one timed item against one untimed one', () => {
    // The untimed item can move within its slot, so there is somewhere for it to
    // go. Flagging this would mean setting a single exact time lights up
    // everything near it in red.
    expect(
      detectConflicts([
        item({ id: 'timed', startMinute: 9 * 60, durationMin: 60 }),
        item({ id: 'floating' }),
      ])
    ).toEqual([])
  })
})

describe('validate', () => {
  it('is valid for an empty plan', () => {
    expect(validate([])).toEqual({ status: 'valid', conflicts: [] })
  })

  it('reports conflicts as the blocking status', () => {
    const result = validate([
      item({ id: 'tour', startMinute: 5 * 60, durationMin: 660 }),
      item({ id: 'spa', slot: 'AFTERNOON', startMinute: 14 * 60, durationMin: 120 }),
    ])

    expect(result.status).toBe('conflicts')
    expect(result.conflicts).toHaveLength(1)
  })
})

describe('resolutionsFor', () => {
  const tour = item({ id: 'tour', title: 'Island tour', startMinute: 5 * 60, durationMin: 660 })
  const spa = item({
    id: 'spa',
    title: 'Spa',
    slot: 'AFTERNOON',
    startMinute: 14 * 60,
    durationMin: 120,
  })

  it('offers the evening, a quieter day, and removal — moving the later item', () => {
    const [conflict] = detectConflicts([tour, spa])
    const resolutions = resolutionsFor(conflict!, [tour, spa], 7)

    expect(resolutions.map((r) => r.label)).toEqual([
      'Move Spa to evening',
      'Move Spa to day 2',
      'Remove Spa',
    ])
  })

  it('never offers a slot the all-day tour already claims', () => {
    const [conflict] = detectConflicts([tour, spa])
    const resolutions = resolutionsFor(conflict!, [tour, spa], 7)

    // The tour claims morning and afternoon, so neither may be offered: a fix
    // that recreates the conflict is worse than no fix at all.
    const slots = resolutions.flatMap((r) => (r.action.kind === 'moveSlot' ? [r.action.slot] : []))
    expect(slots).not.toContain('MORNING')
    expect(slots).not.toContain('AFTERNOON')
  })

  it('picks the emptiest day rather than simply the next one', () => {
    const busyDayTwo = [
      item({ id: 'x', dayNumber: 2 }),
      item({ id: 'y', dayNumber: 2 }),
      item({ id: 'z', dayNumber: 2 }),
    ]
    const [conflict] = detectConflicts([tour, spa])
    const resolutions = resolutionsFor(conflict!, [tour, spa, ...busyDayTwo], 4)

    const dayMove = resolutions.find((r) => r.action.kind === 'moveDay')
    expect(dayMove?.action).toEqual({ kind: 'moveDay', itemId: 'spa', dayNumber: 3 })
  })
})
