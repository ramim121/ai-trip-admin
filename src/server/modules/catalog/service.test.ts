import { describe, expect, it } from 'vitest'
import {
  EARTH_RADIUS_KM,
  EXACT_TAG_MATCH_WEIGHT,
  InvalidTimeWindowError,
  MAX_BLOCK_END_MINUTE,
  PARTIAL_TAG_MATCH_WEIGHT,
  TRANSIT_PROFILES,
  TRAVEL_ROUNDING_MINUTES,
  assertValidTimeWindow,
  estimateMinutesForDistance,
  evaluateOpeningWindows,
  greatCircleKm,
  normaliseInterest,
  rankActivities,
  scoreActivity,
  scoreInterestMatch,
  stemToken,
  toCoordinate,
  toPoint,
  windowsForDay,
  type GeoPoint,
  type OpeningWindow,
  type Rankable,
  type TagSummary,
} from './service'

/**
 * The catalog rules worth testing are the pure ones: ranking, distance, and the
 * opening-hours convention. None of them needs Postgres, which is the point —
 * they were separated from the queries precisely so a test could drive them with
 * a handful of object literals.
 *
 * The database-shaped functions (`searchActivities`, `getActivity`, `isOpenAt`)
 * are thin by design: build a WHERE clause, call Prisma, hand the rows to the
 * functions below. Covering those would mostly be covering Prisma.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function tag(slug: string, label: string): TagSummary {
  return { slug, label }
}

function activity(name: string, sortOrder: number, tags: TagSummary[]): Rankable {
  return { name, sortOrder, tags }
}

const BEACH = tag('beach', 'Beach')
const SNORKELLING = tag('snorkelling', 'Snorkelling')
const STREET_FOOD = tag('street-food', 'Street food')
const TEMPLES = tag('temples', 'Temples')
const CULTURAL_HERITAGE = tag('cultural-heritage', 'Cultural heritage')
const LIVE_MUSIC = tag('live-music', 'Live music')

/** 0 = Sunday … 6 = Saturday, matching Date#getDay(). */
const SUNDAY = 0
const MONDAY = 1
const TUESDAY = 2
const WEDNESDAY = 3
const SATURDAY = 6

function at(hour: number, minute = 0): number {
  return hour * 60 + minute
}

function openOn(days: number[], opens: number, closes: number): OpeningWindow[] {
  return days.map((dayOfWeek) => ({ dayOfWeek, opensMinute: opens, closesMinute: closes }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Interest normalisation
// ─────────────────────────────────────────────────────────────────────────────

describe('normaliseInterest', () => {
  it('folds a traveller phrase into the slug form the catalog uses', () => {
    expect(normaliseInterest('  Street  Food! ')).toBe('street-food')
    expect(normaliseInterest('Live Music')).toBe('live-music')
    expect(normaliseInterest('SNORKELLING')).toBe('snorkelling')
  })

  it('folds underscores and collapses runs of separators', () => {
    expect(normaliseInterest('cultural__heritage')).toBe('cultural-heritage')
    expect(normaliseInterest('beach -- sunset')).toBe('beach-sunset')
  })

  it('returns empty for input with nothing matchable in it', () => {
    expect(normaliseInterest('   ')).toBe('')
    expect(normaliseInterest('!!!')).toBe('')
    expect(normaliseInterest('---')).toBe('')
  })
})

describe('stemToken', () => {
  it('reduces plurals so both sides of a comparison meet', () => {
    expect(stemToken('beaches')).toBe(stemToken('beach'))
    expect(stemToken('temples')).toBe(stemToken('temple'))
    expect(stemToken('caves')).toBe(stemToken('cave'))
  })

  it('leaves short words alone rather than mangling them', () => {
    // Stripping the trailing s would turn "bus" into "bu", and "spa" is not a
    // plural at all. Both are real slugs in the seeded vocabulary.
    expect(stemToken('bus')).toBe('bus')
    expect(stemToken('spa')).toBe('spa')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Interest scoring
// ─────────────────────────────────────────────────────────────────────────────

describe('scoreInterestMatch', () => {
  it('scores an exact slug hit at the exact weight', () => {
    expect(scoreInterestMatch('snorkelling', SNORKELLING)).toBe(EXACT_TAG_MATCH_WEIGHT)
  })

  it('matches the human label as well as the slug', () => {
    expect(scoreInterestMatch('Street food', STREET_FOOD)).toBe(EXACT_TAG_MATCH_WEIGHT)
  })

  it('matches across a plural, which is how travellers actually write', () => {
    expect(scoreInterestMatch('beaches', BEACH)).toBe(EXACT_TAG_MATCH_WEIGHT)
    expect(scoreInterestMatch('temple', TEMPLES)).toBe(EXACT_TAG_MATCH_WEIGHT)
  })

  it('scores a partial hit below an exact one', () => {
    const partial = scoreInterestMatch('heritage', CULTURAL_HERITAGE)
    expect(partial).toBe(PARTIAL_TAG_MATCH_WEIGHT)
    expect(partial).toBeLessThan(EXACT_TAG_MATCH_WEIGHT)
  })

  it('scores an unrelated interest at zero', () => {
    expect(scoreInterestMatch('snorkelling', TEMPLES)).toBe(0)
    expect(scoreInterestMatch('nightlife', BEACH)).toBe(0)
  })

  it('scores an empty or punctuation-only interest at zero rather than matching everything', () => {
    expect(scoreInterestMatch('', BEACH)).toBe(0)
    expect(scoreInterestMatch('   ', BEACH)).toBe(0)
    expect(scoreInterestMatch('!!!', BEACH)).toBe(0)
  })
})

describe('scoreActivity', () => {
  it('counts each interest once, at its best tag', () => {
    // Both tags answer "beaches". If the score summed over tags this would be 4,
    // and an activity could climb the ranking purely by carrying near-duplicate
    // tags — rewarding tag spam by whoever wrote the catalog row.
    const beachy = activity('Beach day', 0, [BEACH, tag('beaches', 'Beaches')])
    expect(scoreActivity(beachy, ['beaches']).matchScore).toBe(EXACT_TAG_MATCH_WEIGHT)
  })

  it('reports the caller own words back, so a UI can say why', () => {
    const outing = activity('Old town walk', 0, [TEMPLES, CULTURAL_HERITAGE])
    const outcome = scoreActivity(outing, ['Temples', 'heritage', 'snorkelling'])

    expect(outcome.matchedInterests).toEqual(['Temples', 'heritage'])
    expect(outcome.matchScore).toBe(EXACT_TAG_MATCH_WEIGHT + PARTIAL_TAG_MATCH_WEIGHT)
  })

  it('scores everything at zero when no interests were supplied', () => {
    const outing = activity('Old town walk', 0, [TEMPLES])
    expect(scoreActivity(outing, [])).toEqual({ matchScore: 0, matchedInterests: [] })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Ranking
// ─────────────────────────────────────────────────────────────────────────────

describe('rankActivities', () => {
  it('puts the widest interest overlap first, regardless of curated order', () => {
    const candidates = [
      activity('Curated favourite', 0, [TEMPLES]),
      activity('Two hits', 9, [BEACH, SNORKELLING]),
      activity('One hit', 5, [BEACH]),
    ]

    const ranked = rankActivities(candidates, ['beach', 'snorkelling'])

    expect(ranked.map((row) => row.name)).toEqual(['Two hits', 'One hit', 'Curated favourite'])
    expect(ranked[0].matchScore).toBe(EXACT_TAG_MATCH_WEIGHT * 2)
    expect(ranked[2].matchScore).toBe(0)
  })

  it('ranks an exact tag hit above a merely partial one', () => {
    const candidates = [
      activity('Partial', 0, [CULTURAL_HERITAGE]),
      activity('Exact', 9, [tag('heritage', 'Heritage')]),
    ]

    expect(rankActivities(candidates, ['heritage'])[0].name).toBe('Exact')
  })

  it('falls back to curated sortOrder when scores tie', () => {
    const candidates = [
      activity('Third in the catalog', 3, [BEACH]),
      activity('First in the catalog', 1, [BEACH]),
      activity('Second in the catalog', 2, [BEACH]),
    ]

    expect(rankActivities(candidates, ['beach']).map((row) => row.name)).toEqual([
      'First in the catalog',
      'Second in the catalog',
      'Third in the catalog',
    ])
  })

  it('keeps curated order when no interests are given at all', () => {
    const candidates = [
      activity('Later', 2, [BEACH]),
      activity('Earlier', 1, [TEMPLES]),
      activity('Latest', 3, [LIVE_MUSIC]),
    ]

    expect(rankActivities(candidates, []).map((row) => row.name)).toEqual([
      'Earlier',
      'Later',
      'Latest',
    ])
  })

  it('is a total order, so an identical request never reshuffles', () => {
    // Same score, same sortOrder. Without the name tie-break the relative order
    // of these two would depend on the engine's sort, and a shortlist that
    // reorders itself on reload looks broken to a traveller.
    const candidates = [activity('Zebra tour', 4, [BEACH]), activity('Apple tour', 4, [BEACH])]

    const first = rankActivities(candidates, ['beach']).map((row) => row.name)
    const second = rankActivities([...candidates].reverse(), ['beach']).map((row) => row.name)

    expect(first).toEqual(['Apple tour', 'Zebra tour'])
    expect(second).toEqual(first)
  })

  it('does not mutate the array it was given', () => {
    const candidates = [activity('B', 2, [BEACH]), activity('A', 1, [BEACH])]
    const snapshot = candidates.map((row) => row.name)

    rankActivities(candidates, ['beach'])

    expect(candidates.map((row) => row.name)).toEqual(snapshot)
  })

  it('carries the source row through untouched', () => {
    const candidates = [{ ...activity('Kept', 1, [BEACH]), id: 'act-1', pricePerPersonBdt: 1800 }]
    const [ranked] = rankActivities(candidates, ['beach'])

    expect(ranked.id).toBe('act-1')
    expect(ranked.pricePerPersonBdt).toBe(1800)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Coordinates
// ─────────────────────────────────────────────────────────────────────────────

describe('toCoordinate and toPoint', () => {
  it('accepts the three forms a coordinate arrives in', () => {
    // A Prisma Decimal (an object with toString), a JSON round trip (string),
    // and a literal in a test (number).
    expect(toCoordinate({ toString: () => '21.427200' })).toBe(21.4272)
    expect(toCoordinate('92.005800')).toBe(92.0058)
    expect(toCoordinate(21.4272)).toBe(21.4272)
  })

  it('treats null, undefined and unparseable input as no coordinate', () => {
    expect(toCoordinate(null)).toBeNull()
    expect(toCoordinate(undefined)).toBeNull()
    expect(toCoordinate('not a number')).toBeNull()
  })

  it('refuses a half-known position rather than placing it on the equator', () => {
    expect(toPoint('21.4272', null)).toBeNull()
    expect(toPoint(null, '92.0058')).toBeNull()
    expect(toPoint('21.4272', '92.0058')).toEqual({ latitude: 21.4272, longitude: 92.0058 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Great-circle distance
// ─────────────────────────────────────────────────────────────────────────────

describe('greatCircleKm', () => {
  const coxsBazar: GeoPoint = { latitude: 21.4272, longitude: 92.0058 }
  const himchari: GeoPoint = { latitude: 21.354, longitude: 92.03 }
  const dhaka: GeoPoint = { latitude: 23.8103, longitude: 90.4125 }

  it('is zero for a point against itself', () => {
    expect(greatCircleKm(coxsBazar, coxsBazar)).toBe(0)
  })

  it('is symmetric', () => {
    expect(greatCircleKm(coxsBazar, dhaka)).toBeCloseTo(greatCircleKm(dhaka, coxsBazar), 9)
  })

  it('matches the known Dhaka to Cox Bazar distance', () => {
    // ~311 km great-circle: 2.383 degrees of latitude is about 265 km, and 1.593
    // degrees of longitude at 22.6 degrees north is about 164 km. A wrong radius
    // or a degrees/radians slip would miss this by a factor, not by kilometres.
    expect(greatCircleKm(dhaka, coxsBazar)).toBeGreaterThan(300)
    expect(greatCircleKm(dhaka, coxsBazar)).toBeLessThan(320)
  })

  it('handles a short hop within one destination', () => {
    // Cox's Bazar beach to Himchari, about 8 km down the Marine Drive.
    const km = greatCircleKm(coxsBazar, himchari)
    expect(km).toBeGreaterThan(7)
    expect(km).toBeLessThan(10)
  })

  it('gives a quarter of the circumference for a 90 degree separation', () => {
    const quarter = (Math.PI / 2) * EARTH_RADIUS_KM
    expect(
      greatCircleKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 90 })
    ).toBeCloseTo(quarter, 6)
  })

  it('does not return NaN for antipodal points', () => {
    // The clamp inside asin exists for exactly this case: floating point can push
    // the haversine term a hair above 1, and Math.asin of that is NaN.
    const antipodal = greatCircleKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 })
    expect(Number.isNaN(antipodal)).toBe(false)
    expect(antipodal).toBeCloseTo(Math.PI * EARTH_RADIUS_KM, 3)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Travel-time estimation
// ─────────────────────────────────────────────────────────────────────────────

const ALL_MODES = Object.keys(TRANSIT_PROFILES) as (keyof typeof TRANSIT_PROFILES)[]

describe('estimateMinutesForDistance', () => {
  it('never returns zero, even for two activities sharing a pin', () => {
    // A temple and the market outside its gate share a coordinate. They are still
    // two places, and a day whose blocks touch with no gap cannot be walked.
    for (const mode of ALL_MODES) {
      expect(estimateMinutesForDistance(0, mode)).toBeGreaterThanOrEqual(TRAVEL_ROUNDING_MINUTES)
    }
  })

  it('rounds up to a five-minute step, never to a false precision', () => {
    for (const mode of ALL_MODES) {
      for (const km of [0, 0.4, 1, 3.7, 12, 250]) {
        expect(estimateMinutesForDistance(km, mode) % TRAVEL_ROUNDING_MINUTES).toBe(0)
      }
    }
  })

  it('computes distance over speed plus overhead, then rounds up', () => {
    // WALK: 1 km x 1.25 detour = 1.25 km at 4.5 km/h = 16.67 min, no overhead,
    // rounded up to the next five.
    expect(estimateMinutesForDistance(1, 'WALK')).toBe(20)

    // CAR: 10 km x 1.35 = 13.5 km at 26 km/h = 31.15 min, plus 10 minutes of
    // parking and the walk from it = 41.15, rounded up.
    expect(estimateMinutesForDistance(10, 'CAR')).toBe(45)
  })

  it('charges the fixed overhead even on a trivially short hop', () => {
    // This is the whole reason overhead is modelled separately: a two-kilometre
    // ferry crossing costs a terminal, a ticket and a queue; a two-kilometre walk
    // costs none of them.
    expect(estimateMinutesForDistance(2, 'FERRY')).toBeGreaterThan(
      estimateMinutesForDistance(2, 'WALK')
    )
    expect(estimateMinutesForDistance(2, 'FERRY')).toBeGreaterThanOrEqual(
      TRANSIT_PROFILES.FERRY.overheadMinutes
    )
  })

  it('is monotonic in distance', () => {
    let previous = 0
    for (const km of [0, 1, 5, 20, 100, 500]) {
      const minutes = estimateMinutesForDistance(km, 'CAR')
      expect(minutes).toBeGreaterThanOrEqual(previous)
      previous = minutes
    }
  })

  it('makes the faster mode faster once distance dominates the overhead', () => {
    const km = 60
    expect(estimateMinutesForDistance(km, 'TRAIN')).toBeLessThan(
      estimateMinutesForDistance(km, 'BUS')
    )
    expect(estimateMinutesForDistance(km, 'CAR')).toBeLessThan(
      estimateMinutesForDistance(km, 'WALK')
    )
  })

  it('treats a negative distance as zero rather than returning a negative time', () => {
    expect(estimateMinutesForDistance(-5, 'CAR')).toBe(estimateMinutesForDistance(0, 'CAR'))
  })

  it('inflates the straight line rather than taking it literally', () => {
    // 10 km of straight line by car must cost more than 10 km of road would at
    // the same speed, because real routes are longer than lines on a map.
    const straightLineMinutes = (10 / TRANSIT_PROFILES.CAR.averageSpeedKmh) * 60
    expect(estimateMinutesForDistance(10, 'CAR')).toBeGreaterThan(straightLineMinutes)
  })

  it('keeps every profile physically sensible', () => {
    for (const mode of ALL_MODES) {
      const profile = TRANSIT_PROFILES[mode]
      expect(profile.averageSpeedKmh).toBeGreaterThan(0)
      expect(profile.overheadMinutes).toBeGreaterThanOrEqual(0)
      // A detour factor below 1 would claim a route shorter than the straight
      // line between its endpoints.
      expect(profile.detourFactor).toBeGreaterThanOrEqual(1)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Opening hours
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateOpeningWindows', () => {
  it('treats an activity with no rows at all as always available', () => {
    // schema.prisma's convention. A public beach, a viewpoint, a coast road —
    // reading no rows as "closed" would delete half the catalog from every plan.
    const result = evaluateOpeningWindows([], WEDNESDAY, at(3), at(5))

    expect(result.isOpen).toBe(true)
    expect(result.reason).toBe('ALWAYS_OPEN')
    expect(result.windowsOnDay).toEqual([])
  })

  it('treats a weekday with no row as closed once any row exists', () => {
    const mondayOnly = openOn([MONDAY], at(9), at(17))
    const result = evaluateOpeningWindows(mondayOnly, TUESDAY, at(10), at(12))

    expect(result.isOpen).toBe(false)
    expect(result.reason).toBe('CLOSED_ON_DAY')
    expect(result.windowsOnDay).toEqual([])
  })

  it('accepts a slot fully inside a window', () => {
    const hours = openOn([MONDAY], at(9), at(17))
    const result = evaluateOpeningWindows(hours, MONDAY, at(10), at(12))

    expect(result.isOpen).toBe(true)
    expect(result.reason).toBe('WITHIN_HOURS')
    expect(result.windowsOnDay).toEqual([{ opensMinute: at(9), closesMinute: at(17) }])
  })

  it('accepts a slot flush against both edges', () => {
    const hours = openOn([MONDAY], at(9), at(17))
    expect(evaluateOpeningWindows(hours, MONDAY, at(9), at(17)).isOpen).toBe(true)
  })

  it('refuses a slot that starts before opening rather than calling it partly open', () => {
    // A traveller who arrives twenty minutes early is standing at a locked gate
    // holding a plan that told them otherwise. Containment, not intersection.
    const hours = openOn([MONDAY], at(9), at(17))
    const result = evaluateOpeningWindows(hours, MONDAY, at(8, 40), at(11))

    expect(result.isOpen).toBe(false)
    expect(result.reason).toBe('OUTSIDE_HOURS')
  })

  it('refuses a slot that runs past closing', () => {
    const hours = openOn([MONDAY], at(9), at(17))
    expect(evaluateOpeningWindows(hours, MONDAY, at(16), at(18)).isOpen).toBe(false)
  })

  it('honours a genuine midday break', () => {
    const hours: OpeningWindow[] = [
      { dayOfWeek: MONDAY, opensMinute: at(9), closesMinute: at(12) },
      { dayOfWeek: MONDAY, opensMinute: at(14), closesMinute: at(18) },
    ]

    expect(evaluateOpeningWindows(hours, MONDAY, at(10), at(11)).isOpen).toBe(true)
    expect(evaluateOpeningWindows(hours, MONDAY, at(15), at(17)).isOpen).toBe(true)
    // Straddles the break.
    expect(evaluateOpeningWindows(hours, MONDAY, at(11), at(15)).isOpen).toBe(false)
    // Sits inside the break.
    expect(evaluateOpeningWindows(hours, MONDAY, at(12, 30), at(13)).isOpen).toBe(false)

    expect(evaluateOpeningWindows(hours, MONDAY, at(10), at(11)).windowsOnDay).toHaveLength(2)
  })

  it('merges two windows that touch, since a zero-minute break is not a break', () => {
    const hours: OpeningWindow[] = [
      { dayOfWeek: MONDAY, opensMinute: at(9), closesMinute: at(12) },
      { dayOfWeek: MONDAY, opensMinute: at(12), closesMinute: at(17) },
    ]

    const result = evaluateOpeningWindows(hours, MONDAY, at(11), at(14))

    expect(result.isOpen).toBe(true)
    expect(result.windowsOnDay).toEqual([{ opensMinute: at(9), closesMinute: at(17) }])
  })

  it('merges overlapping windows regardless of the order they arrive in', () => {
    const hours: OpeningWindow[] = [
      { dayOfWeek: MONDAY, opensMinute: at(14), closesMinute: at(20) },
      { dayOfWeek: MONDAY, opensMinute: at(9), closesMinute: at(16) },
    ]

    expect(evaluateOpeningWindows(hours, MONDAY, at(10), at(19)).windowsOnDay).toEqual([
      { opensMinute: at(9), closesMinute: at(20) },
    ])
  })

  it('serves a small-hours slot from the previous day overrunning window', () => {
    // A night market open Monday 18:00 to 02:00 has one row: Monday 1080-1560.
    // A block at 01:00 on TUESDAY is covered by it. Reading Tuesday's own rows
    // alone would report the market closed while its lights are still on.
    const nightMarket = openOn([MONDAY], at(18), at(26))

    const tuesdayNight = evaluateOpeningWindows(nightMarket, TUESDAY, at(0, 30), at(1, 30))
    expect(tuesdayNight.isOpen).toBe(true)
    expect(tuesdayNight.reason).toBe('WITHIN_HOURS')
    expect(tuesdayNight.windowsOnDay).toEqual([{ opensMinute: 0, closesMinute: at(2) }])
  })

  it('stops covering once the overrun ends', () => {
    const nightMarket = openOn([MONDAY], at(18), at(26))
    expect(evaluateOpeningWindows(nightMarket, TUESDAY, at(1, 30), at(2, 30)).isOpen).toBe(false)
  })

  it('covers a same-day block that itself runs past midnight', () => {
    const nightMarket = openOn([MONDAY], at(18), at(26))
    // 23:00 Monday to 01:00 Tuesday, expressed as 1380-1500 on Monday.
    expect(evaluateOpeningWindows(nightMarket, MONDAY, at(23), at(25)).isOpen).toBe(true)
    // 23:00 Monday to 03:00 Tuesday runs past the 02:00 close.
    expect(evaluateOpeningWindows(nightMarket, MONDAY, at(23), at(27)).isOpen).toBe(false)
  })

  it('wraps from Saturday to Sunday, not off the end of the week', () => {
    const saturdayNight = openOn([SATURDAY], at(20), at(27))
    expect(evaluateOpeningWindows(saturdayNight, SUNDAY, at(1), at(2)).isOpen).toBe(true)
  })

  it('wraps from Sunday back to Saturday when looking for yesterday', () => {
    const sundayNight = openOn([SUNDAY], at(20), at(27))
    // Monday morning is served by Sunday's overrun; Saturday morning is not.
    expect(evaluateOpeningWindows(sundayNight, MONDAY, at(1), at(2)).isOpen).toBe(true)
    expect(evaluateOpeningWindows(sundayNight, SATURDAY, at(1), at(2)).isOpen).toBe(false)
  })

  it('handles a daily schedule on every weekday', () => {
    const daily = openOn([0, 1, 2, 3, 4, 5, 6], at(8), at(17))
    for (let day = 0; day <= 6; day += 1) {
      expect(evaluateOpeningWindows(daily, day, at(9), at(11)).isOpen).toBe(true)
      expect(evaluateOpeningWindows(daily, day, at(18), at(19)).isOpen).toBe(false)
    }
  })
})

describe('windowsForDay', () => {
  it('reports nothing for a day the activity does not open', () => {
    expect(windowsForDay(openOn([MONDAY], at(9), at(17)), TUESDAY)).toEqual([])
  })

  it('clamps a previous-day overrun to this day rather than carrying it negative', () => {
    // Monday 18:00-02:00 becomes Tuesday 00:00-02:00. A window opening at -360
    // would look open at 23:00 the night before, which is Monday's business.
    expect(windowsForDay(openOn([MONDAY], at(18), at(26)), TUESDAY)).toEqual([
      { opensMinute: 0, closesMinute: at(2) },
    ])
  })

  it('combines today own window with yesterday overrun', () => {
    const hours: OpeningWindow[] = [
      { dayOfWeek: MONDAY, opensMinute: at(18), closesMinute: at(26) },
      { dayOfWeek: TUESDAY, opensMinute: at(9), closesMinute: at(17) },
    ]

    expect(windowsForDay(hours, TUESDAY)).toEqual([
      { opensMinute: 0, closesMinute: at(2) },
      { opensMinute: at(9), closesMinute: at(17) },
    ])
  })

  it('ignores a previous-day window that does not run past midnight', () => {
    expect(windowsForDay(openOn([MONDAY], at(9), at(17)), TUESDAY)).toEqual([])
  })
})

describe('assertValidTimeWindow', () => {
  it('accepts a normal slot', () => {
    expect(() => assertValidTimeWindow(MONDAY, at(9), at(11))).not.toThrow()
  })

  it('accepts a slot that runs to the following midnight', () => {
    expect(() => assertValidTimeWindow(MONDAY, at(23), MAX_BLOCK_END_MINUTE)).not.toThrow()
  })

  it('rejects a weekday outside 0 to 6', () => {
    expect(() => assertValidTimeWindow(7, at(9), at(11))).toThrow(InvalidTimeWindowError)
    expect(() => assertValidTimeWindow(-1, at(9), at(11))).toThrow(InvalidTimeWindowError)
    expect(() => assertValidTimeWindow(1.5, at(9), at(11))).toThrow(InvalidTimeWindowError)
  })

  it('rejects an end at or before the start', () => {
    expect(() => assertValidTimeWindow(MONDAY, at(11), at(11))).toThrow(InvalidTimeWindowError)
    expect(() => assertValidTimeWindow(MONDAY, at(11), at(9))).toThrow(InvalidTimeWindowError)
  })

  it('rejects a start outside the day it is counted from', () => {
    expect(() => assertValidTimeWindow(MONDAY, -1, at(9))).toThrow(InvalidTimeWindowError)
    expect(() => assertValidTimeWindow(MONDAY, 1440, 1500)).toThrow(InvalidTimeWindowError)
  })

  it('rejects a block running beyond the next midnight', () => {
    expect(() => assertValidTimeWindow(MONDAY, at(23), MAX_BLOCK_END_MINUTE + 1)).toThrow(
      InvalidTimeWindowError
    )
  })

  it('rejects a non-integer minute', () => {
    expect(() => assertValidTimeWindow(MONDAY, 540.5, 660)).toThrow(InvalidTimeWindowError)
  })
})
