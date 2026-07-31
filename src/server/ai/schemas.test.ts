import { describe, expect, it } from 'vitest'
import {
  BudgetBand as PrismaBudgetBand,
  ItineraryBlockKind as PrismaBlockKind,
  TransportPreference as PrismaTransportPreference,
  TripPace as PrismaTripPace,
  TripPurpose as PrismaTripPurpose,
} from '@/generated/prisma/enums'
import {
  ActivitySuggestionSchema,
  BUDGET_BANDS,
  DAY_BLOCK_KINDS,
  DayBlockSchema,
  DayPlanProposalSchema,
  MAX_TEASER_DAY_HIGHLIGHTS,
  TRANSPORT_PREFERENCES,
  TRIP_PACES,
  TRIP_PURPOSES,
  TeaserResponseSchema,
  TripBriefSchema,
  mergeTripBrief,
  referencedActivityIds,
  teaserCacheKey,
  tripBriefIsPlannable,
  type TripBrief,
} from './schemas'

/**
 * These schemas are a contract, and the tests that matter are the ones about
 * what they *refuse*. Anything a model can smuggle past validation reaches a
 * traveller, so refusals are asserted far more heavily than successes.
 */

const ACTIVITY_ID = '019373d4-4a1b-7c3e-9f00-1111aaaa0001'
const OTHER_ACTIVITY_ID = '019373d4-4a1b-7c3e-9f00-2222bbbb0002'

/** A valid activity block, so each test can vary exactly one thing. */
function activityBlock(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'ACTIVITY',
    activityId: ACTIVITY_ID,
    title: 'Sunrise boat to the mangroves',
    startMinute: 330,
    endMinute: 480,
    rationale: 'The channels are calm and the light is best before the wind picks up.',
    ...overrides,
  }
}

/** Issue paths as dotted strings, for asserting *where* validation failed. */
function issuePaths(result: { error?: { issues: readonly { path: PropertyKey[] }[] } }): string[] {
  return (result.error?.issues ?? []).map((issue) => issue.path.join('.'))
}

describe('vocabularies stay in step with the database', () => {
  // The compile-time assertions in schemas.ts catch type drift. These catch the
  // case where someone loosens a type to quiet tsc: the values the model may
  // emit must be exactly the values the enum columns accept, or a perfectly
  // valid plan fails on insert.
  it.each([
    ['TripPurpose', TRIP_PURPOSES, PrismaTripPurpose],
    ['TripPace', TRIP_PACES, PrismaTripPace],
    ['TransportPreference', TRANSPORT_PREFERENCES, PrismaTransportPreference],
    ['BudgetBand', BUDGET_BANDS, PrismaBudgetBand],
    ['ItineraryBlockKind', DAY_BLOCK_KINDS, PrismaBlockKind],
  ])('%s matches the Prisma enum exactly', (_name, ours, theirs) => {
    expect([...ours].sort()).toEqual(Object.values(theirs).sort())
  })
})

describe('TripBriefSchema', () => {
  it('accepts an empty brief, because the first turn knows nothing', () => {
    const result = TripBriefSchema.safeParse({})

    expect(result.success).toBe(true)
    // Lists arrive present-but-empty so callers never guard for undefined.
    expect(result.data).toEqual({ interests: [], mustSee: [], avoid: [] })
  })

  it('accumulates a partial brief without demanding the rest', () => {
    const result = TripBriefSchema.safeParse({ destination: 'Sylhet', totalDays: 3 })

    expect(result.success).toBe(true)
    expect(result.data?.partySize).toBeUndefined()
    expect(result.data?.startDate).toBeUndefined()
  })

  it('trims whitespace, so "Sylhet " is not a second destination', () => {
    const result = TripBriefSchema.safeParse({ destination: '  Sylhet  ', interests: [' tea '] })

    expect(result.data?.destination).toBe('Sylhet')
    expect(result.data?.interests).toEqual(['tea'])
  })

  it('takes a calendar date and refuses a timestamp or a local format', () => {
    expect(TripBriefSchema.safeParse({ startDate: '2026-11-04' }).success).toBe(true)
    expect(TripBriefSchema.safeParse({ startDate: '2026-11-04T09:00:00Z' }).success).toBe(false)
    expect(TripBriefSchema.safeParse({ startDate: '04-11-2026' }).success).toBe(false)
  })

  it.each([
    ['zero days', { totalDays: 0 }],
    ['days above the ceiling', { totalDays: 31 }],
    ['fractional days', { totalDays: 2.5 }],
    ['a party of nobody', { partySize: 0 }],
    ['a destinationId that is not a uuid', { destinationId: 'sylhet' }],
    ['a purpose the database has never heard of', { purpose: 'LEISURE' }],
    ['a budget band the database has never heard of', { budgetBand: 'SHOESTRING' }],
  ])('refuses %s', (_label, patch) => {
    expect(TripBriefSchema.safeParse(patch).success).toBe(false)
  })

  it('caps list length so a runaway model cannot flood the next turn', () => {
    const flood = Array.from({ length: 21 }, (_, i) => `interest-${i}`)

    expect(TripBriefSchema.safeParse({ interests: flood }).success).toBe(false)
  })
})

describe('tripBriefIsPlannable', () => {
  const base = TripBriefSchema.parse({})

  it('is false until destination, days and party size are all known', () => {
    expect(tripBriefIsPlannable(base)).toBe(false)
    expect(tripBriefIsPlannable({ ...base, destination: 'Sylhet' })).toBe(false)
    expect(tripBriefIsPlannable({ ...base, destination: 'Sylhet', totalDays: 3 })).toBe(false)
  })

  it('is true once all three are present', () => {
    expect(
      tripBriefIsPlannable({ ...base, destination: 'Sylhet', totalDays: 3, partySize: 2 })
    ).toBe(true)
  })
})

describe('mergeTripBrief', () => {
  const base: TripBrief = TripBriefSchema.parse({
    destination: 'Sylhet',
    totalDays: 3,
    interests: ['tea gardens'],
    mustSee: ['Ratargul'],
  })

  it('overwrites a scalar the traveller corrected', () => {
    expect(mergeTripBrief(base, { totalDays: 5 }).totalDays).toBe(5)
  })

  it('does not let an omitted field erase what we already knew', () => {
    // A model answering a question about pace must not drop the destination
    // just because it did not repeat it.
    const merged = mergeTripBrief(base, { pace: 'RELAXED', destination: undefined })

    expect(merged.destination).toBe('Sylhet')
    expect(merged.pace).toBe('RELAXED')
  })

  it('unions lists instead of replacing them, and does not duplicate', () => {
    const merged = mergeTripBrief(base, { interests: ['tea gardens', 'waterfalls'] })

    expect(merged.interests).toEqual(['tea gardens', 'waterfalls'])
  })

  it('leaves lists untouched when the patch says nothing about them', () => {
    expect(mergeTripBrief(base, { partySize: 2 }).mustSee).toEqual(['Ratargul'])
  })
})

describe('teaserCacheKey', () => {
  const answers = {
    destination: "Cox's Bazar",
    totalDays: 4,
    partySize: 2,
    purpose: 'HONEYMOON',
  } as const

  it('collapses case and spacing, so retyping the trip is one cache entry', () => {
    // This is the whole defence against burning AI spend on bypass attempts.
    expect(teaserCacheKey({ ...answers, destination: "  cox's   BAZAR " })).toBe(
      teaserCacheKey(answers)
    )
  })

  it('separates trips that differ in any single answer', () => {
    expect(teaserCacheKey({ ...answers, totalDays: 5 })).not.toBe(teaserCacheKey(answers))
    expect(teaserCacheKey({ ...answers, partySize: 3 })).not.toBe(teaserCacheKey(answers))
    expect(teaserCacheKey({ ...answers, purpose: 'FAMILY' })).not.toBe(teaserCacheKey(answers))
  })
})

describe('DayBlockSchema — the catalog rule', () => {
  it('accepts a well-formed activity block', () => {
    expect(DayBlockSchema.safeParse(activityBlock()).success).toBe(true)
  })

  it('refuses an ACTIVITY with no catalog id — the invented-activity guard', () => {
    const result = DayBlockSchema.safeParse(activityBlock({ activityId: undefined }))

    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('activityId')
  })

  it('refuses a non-ACTIVITY block that carries a catalog id', () => {
    const result = DayBlockSchema.safeParse(activityBlock({ kind: 'MEAL' }))

    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('activityId')
  })

  it('refuses an activity id that is not a uuid', () => {
    expect(DayBlockSchema.safeParse(activityBlock({ activityId: 'ratargul-swamp' })).success).toBe(
      false
    )
  })

  it.each([
    ['a block that ends before it starts', { startMinute: 600, endMinute: 540 }],
    ['a zero-length block', { startMinute: 600, endMinute: 600 }],
    ['an end past midnight', { startMinute: 600, endMinute: 1441 }],
    ['a negative start', { startMinute: -1, endMinute: 600 }],
  ])('refuses %s', (_label, times) => {
    expect(DayBlockSchema.safeParse(activityBlock(times)).success).toBe(false)
  })

  it('allows a block that runs exactly to midnight', () => {
    const result = DayBlockSchema.safeParse(
      activityBlock({ kind: 'FREE', activityId: undefined, startMinute: 1380, endMinute: 1440 })
    )

    expect(result.success).toBe(true)
  })
})

describe('DayPlanProposalSchema', () => {
  const day = {
    dayNumber: 1,
    title: 'Into the wetlands',
    blocks: [
      activityBlock(),
      activityBlock({ kind: 'MEAL', activityId: undefined, startMinute: 480, endMinute: 540 }),
    ],
  }

  it('accepts a day whose blocks run back to back', () => {
    expect(DayPlanProposalSchema.safeParse(day).success).toBe(true)
  })

  it('refuses overlapping blocks and says which one overlaps', () => {
    // Models pad thin days by double-booking; a traveller cannot be in two
    // places at 08:10, so this is checked rather than trusted.
    const overlapping = {
      ...day,
      blocks: [
        activityBlock(),
        activityBlock({ activityId: OTHER_ACTIVITY_ID, startMinute: 470, endMinute: 560 }),
      ],
    }
    const result = DayPlanProposalSchema.safeParse(overlapping)

    expect(result.success).toBe(false)
    expect(issuePaths(result)).toContain('blocks.1.startMinute')
  })

  it('refuses an empty day', () => {
    expect(DayPlanProposalSchema.safeParse({ ...day, blocks: [] }).success).toBe(false)
  })

  it('refuses a day number outside the trip-length ceiling', () => {
    expect(DayPlanProposalSchema.safeParse({ ...day, dayNumber: 0 }).success).toBe(false)
    expect(DayPlanProposalSchema.safeParse({ ...day, dayNumber: 31 }).success).toBe(false)
  })

  it('rejects the whole day when one block breaks the catalog rule', () => {
    const smuggled = {
      ...day,
      blocks: [
        activityBlock(),
        activityBlock({ activityId: undefined, startMinute: 480, endMinute: 600 }),
      ],
    }

    expect(DayPlanProposalSchema.safeParse(smuggled).success).toBe(false)
  })
})

describe('referencedActivityIds', () => {
  it('collects catalog ids once each and ignores non-activity blocks', () => {
    const day = DayPlanProposalSchema.parse({
      dayNumber: 1,
      title: 'Tea country',
      blocks: [
        activityBlock(),
        activityBlock({ kind: 'MEAL', activityId: undefined, startMinute: 480, endMinute: 540 }),
        activityBlock({ startMinute: 540, endMinute: 660 }),
        activityBlock({ activityId: OTHER_ACTIVITY_ID, startMinute: 660, endMinute: 780 }),
      ],
    })

    expect(referencedActivityIds(day)).toEqual([ACTIVITY_ID, OTHER_ACTIVITY_ID])
  })
})

describe('ActivitySuggestionSchema', () => {
  const suggestion = {
    activityId: ACTIVITY_ID,
    whyRecommended: 'Matches their interest in birdlife and fits a slow morning.',
    suggestedStartMinute: 420,
    confidence: 0.8,
  }

  it('accepts a well-formed suggestion', () => {
    expect(ActivitySuggestionSchema.safeParse(suggestion).success).toBe(true)
  })

  it.each([0, 1])('accepts confidence at the boundary (%s)', (confidence) => {
    expect(ActivitySuggestionSchema.safeParse({ ...suggestion, confidence }).success).toBe(true)
  })

  it.each([-0.1, 1.1])('refuses confidence outside 0-1 (%s)', (confidence) => {
    expect(ActivitySuggestionSchema.safeParse({ ...suggestion, confidence }).success).toBe(false)
  })

  it('refuses a suggestion with no catalog id', () => {
    expect(
      ActivitySuggestionSchema.safeParse({ ...suggestion, activityId: undefined }).success
    ).toBe(false)
  })

  it('refuses a start minute at or past midnight', () => {
    expect(
      ActivitySuggestionSchema.safeParse({ ...suggestion, suggestedStartMinute: 1440 }).success
    ).toBe(false)
  })
})

describe('TeaserResponseSchema', () => {
  const highlight = (dayNumber: number) => ({
    dayNumber,
    headline: `Day ${dayNumber}`,
    summary: 'A slow start, then the water.',
  })

  const teaser = {
    headline: 'Four quiet days on the coast',
    overview: 'Long beaches, early boats, and nothing that needs an alarm clock.',
    dayHighlights: [highlight(1), highlight(2)],
    callToAction: 'Sign in and we will build the full plan together.',
  }

  it('accepts a preview and defaults the interest chips to empty', () => {
    const result = TeaserResponseSchema.safeParse(teaser)

    expect(result.success).toBe(true)
    expect(result.data?.suggestedInterests).toEqual([])
  })

  it('refuses more highlighted days than a preview may show', () => {
    // This cap is what stops the teaser quietly becoming the paid itinerary.
    const tooMany = {
      ...teaser,
      dayHighlights: Array.from({ length: MAX_TEASER_DAY_HIGHLIGHTS + 1 }, (_, i) =>
        highlight(i + 1)
      ),
    }

    expect(TeaserResponseSchema.safeParse(tooMany).success).toBe(false)
  })

  it('refuses a teaser with no highlights, and one with no call to action', () => {
    expect(TeaserResponseSchema.safeParse({ ...teaser, dayHighlights: [] }).success).toBe(false)
    expect(TeaserResponseSchema.safeParse({ ...teaser, callToAction: '   ' }).success).toBe(false)
  })

  it('refuses an overview long enough to be a full itinerary', () => {
    expect(TeaserResponseSchema.safeParse({ ...teaser, overview: 'x'.repeat(801) }).success).toBe(
      false
    )
  })
})
