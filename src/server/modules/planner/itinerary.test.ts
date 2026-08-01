import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/server/http/errors'

/**
 * What the planner does with the answers the entitlement layer gives it.
 *
 * `entitlements/service.test.ts` already pins the arithmetic — a FREE account
 * gets two days, an unlocked itinerary gets thirty. What it cannot show is
 * whether this module *listens*. The expensive failure here is not a wrong
 * allowance, it is a correct allowance that nothing enforces: seven day rows
 * created from an allowance of two looks perfectly healthy in every log we keep,
 * and quietly gives the product away.
 *
 * So these tests assert on what was actually written — how many day rows, with
 * what `totalDays` beside them — rather than on what was returned.
 *
 * The other two properties here fail just as silently. Ownership is a WHERE
 * clause, and a missing one is invisible until somebody reads a stranger's trip.
 * And `syncTransitBlocks` deletes before it inserts, so a wrong predicate there
 * destroys a transfer a traveller typed in by hand.
 */

const itineraryCreate = vi.fn()
const itineraryFindFirst = vi.fn()
const itineraryUpdate = vi.fn()
const dayFindUnique = vi.fn()
const blockFindMany = vi.fn()
const blockDeleteMany = vi.fn()
const blockCreateMany = vi.fn()
const blockCreate = vi.fn()
const blockUpdate = vi.fn()

vi.mock('@/lib/db', () => ({
  db: {
    itinerary: {
      create: (...a: unknown[]) => itineraryCreate(...a) as unknown,
      findFirst: (...a: unknown[]) => itineraryFindFirst(...a) as unknown,
      update: (...a: unknown[]) => itineraryUpdate(...a) as unknown,
    },
    itineraryDay: { findUnique: (...a: unknown[]) => dayFindUnique(...a) as unknown },
    itineraryBlock: {
      findMany: (...a: unknown[]) => blockFindMany(...a) as unknown,
      deleteMany: (...a: unknown[]) => blockDeleteMany(...a) as unknown,
      createMany: (...a: unknown[]) => blockCreateMany(...a) as unknown,
      create: (...a: unknown[]) => blockCreate(...a) as unknown,
      update: (...a: unknown[]) => blockUpdate(...a) as unknown,
    },
  },
}))

const searchActivities = vi.fn()
const getActivitiesByIds = vi.fn()
const matchDestination = vi.fn()

vi.mock('@/server/modules/catalog/service', async (importOriginal) => ({
  // The pure geometry and opening-hours helpers stay real: the transit
  // assertions below are only meaningful if the distances are.
  ...(await importOriginal<typeof import('@/server/modules/catalog/service')>()),
  searchActivities: (...a: unknown[]) => searchActivities(...a) as unknown,
  getActivitiesByIds: (...a: unknown[]) => getActivitiesByIds(...a) as unknown,
  matchDestination: (...a: unknown[]) => matchDestination(...a) as unknown,
}))

const canGenerateDays = vi.fn()
const claimItineraryCreation = vi.fn()
const releaseItineraryCreation = vi.fn()
const claimSaveSlot = vi.fn()

vi.mock('@/server/modules/entitlements/service', async (importOriginal) => ({
  // `daysToGenerate`, `entitlementRefused` and `userActor` stay real — they are
  // the parts under test on this side of the boundary. The claims are mocked
  // because what matters here is that this module ASKS for one before it writes;
  // whether the claim is itself race-free is pinned in `service.test.ts`.
  ...(await importOriginal<typeof import('@/server/modules/entitlements/service')>()),
  canGenerateDays: (...a: unknown[]) => canGenerateDays(...a) as unknown,
  claimItineraryCreation: (...a: unknown[]) => claimItineraryCreation(...a) as unknown,
  releaseItineraryCreation: (...a: unknown[]) => releaseItineraryCreation(...a) as unknown,
  claimSaveSlot: (...a: unknown[]) => claimSaveSlot(...a) as unknown,
}))

const markConverted = vi.fn()
vi.mock('./session', () => ({ markConverted: (...a: unknown[]) => markConverted(...a) as unknown }))

const {
  addBlock,
  createItineraryFromBrief,
  getItinerary,
  moveBlock,
  regenerateDay,
  saveItinerary,
  syncTransitBlocks,
} = await import('./itinerary')

const USER_ID = '0199c0de-0000-7000-8000-000000000001'
const OTHER_USER_ID = '0199c0de-0000-7000-8000-0000000000ff'
const ITINERARY_ID = '0199c0de-0000-7000-8000-000000000002'
const DAY_ID = '0199c0de-0000-7000-8000-000000000003'

/** Cox's Bazar beachfront, and a point ~4.8 km north of it. */
const BEACH = { latitude: 21.4272, longitude: 92.0058 }
const ACROSS_TOWN = { latitude: 21.47, longitude: 92.01 }

const FREE_ALLOWANCE = {
  maxDays: 2,
  unlimited: false,
  unlocked: false,
  source: 'PLAN' as const,
  entitlement: { planName: 'Free' } as never,
  refusal: {
    reason: 'FREE_DAY_LIMIT' as const,
    message: 'Free plans the first 2 days of a trip.',
    upgrade: {
      action: 'UNLOCK_ITINERARY' as const,
      planCode: 'UNLOCK_SINGLE' as const,
      priceBdt: 200,
      label: 'Unlock this itinerary in full for 200 BDT',
      itineraryId: ITINERARY_ID,
    },
  },
}

const BRIEF = {
  destination: "Cox's Bazar",
  totalDays: 7,
  partySize: 2,
  interests: [],
  mustSee: [],
  avoid: [],
}

/** The row `assemble()` reads back. Empty days keep this about day counts. */
function itineraryRow(dayCount: number) {
  return {
    id: ITINERARY_ID,
    userId: USER_ID,
    plannerSessionId: null,
    title: "Cox's Bazar trip",
    destinationId: null,
    destinationLabel: "Cox's Bazar",
    startDate: null,
    endDate: null,
    totalDays: 7,
    partySize: 2,
    purpose: 'VACATION',
    pace: 'BALANCED',
    transportPreference: 'PRIVATE_CAR',
    budgetBand: null,
    status: 'DRAFT',
    isFullyUnlocked: false,
    coverImageUrl: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    days: Array.from({ length: dayCount }, (_, index) => ({
      id: `day-${index + 1}`,
      dayNumber: index + 1,
      date: null,
      title: null,
      notes: null,
      blocks: [],
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()

  canGenerateDays.mockResolvedValue(FREE_ALLOWANCE)
  matchDestination.mockResolvedValue(null)
  searchActivities.mockResolvedValue({ activities: [], matched: 0, truncated: false })
  getActivitiesByIds.mockResolvedValue(new Map())
  blockFindMany.mockResolvedValue([])
  blockDeleteMany.mockResolvedValue({ count: 0 })
  blockCreateMany.mockResolvedValue({ count: 0 })
  blockCreate.mockResolvedValue({ id: 'block-1' })
  blockUpdate.mockResolvedValue({ id: 'block-1' })
  dayFindUnique.mockResolvedValue({ blocks: [] })
  claimItineraryCreation.mockResolvedValue({ allowed: true, remaining: 9 })
  releaseItineraryCreation.mockResolvedValue(undefined)
  claimSaveSlot.mockResolvedValue({
    decision: { allowed: true, remaining: 2 },
    claimed: true,
  })
  markConverted.mockResolvedValue(undefined)

  // Creation answers with exactly the days it was asked to create, so a test
  // observes the count this module chose rather than one the mock invented.
  itineraryCreate.mockImplementation((args: { data: { days: { create: unknown[] } } }) =>
    Promise.resolve(itineraryRow(args.data.days.create.length))
  )
  itineraryFindFirst.mockResolvedValue(itineraryRow(2))
})

describe('createItineraryFromBrief — day-limit enforcement', () => {
  it('creates two days for a seven-day request on the free tier', async () => {
    const result = await createItineraryFromBrief({ userId: USER_ID, brief: BRIEF })

    const created = itineraryCreate.mock.calls[0][0] as {
      data: { days: { create: { dayNumber: number }[] } }
    }

    expect(created.data.days.create).toHaveLength(2)
    expect(created.data.days.create.map((day) => day.dayNumber)).toEqual([1, 2])
    expect(result.generatedDays).toBe(2)
    expect(result.requestedDays).toBe(7)
  })

  it('records the trip they asked for, not the part we planned', async () => {
    // Storing 2 here would erase the fact that there is anything left to
    // unlock, and the one-off purchase would have nothing to reveal.
    await createItineraryFromBrief({ userId: USER_ID, brief: BRIEF })

    const created = itineraryCreate.mock.calls[0][0] as { data: { totalDays: number } }
    expect(created.data.totalDays).toBe(7)
  })

  it('returns the refusal alongside the plan rather than throwing', async () => {
    const result = await createItineraryFromBrief({ userId: USER_ID, brief: BRIEF })

    expect(result.allowance.refusal?.reason).toBe('FREE_DAY_LIMIT')
    expect(result.allowance.refusal?.upgrade?.priceBdt).toBe(200)
  })

  it('asks the entitlement layer before writing anything', async () => {
    await createItineraryFromBrief({ userId: USER_ID, brief: BRIEF })

    expect(canGenerateDays).toHaveBeenCalled()
    expect(canGenerateDays.mock.invocationCallOrder[0]).toBeLessThan(
      itineraryCreate.mock.invocationCallOrder[0]
    )
  })

  it('claims one generation per itinerary, not per day, and claims it before writing', async () => {
    // This used to assert an unconditional `recordUsage` AFTER the write — an
    // increment into a counter that no check on this path ever read back, which
    // is why a PREMIUM_10 subscriber who had spent their ten kept generating.
    // The claim is now a decision, and it is taken before anything is created.
    await createItineraryFromBrief({ userId: USER_ID, brief: BRIEF })

    expect(claimItineraryCreation).toHaveBeenCalledTimes(1)
    expect(claimItineraryCreation).toHaveBeenCalledWith(USER_ID)
    expect(claimItineraryCreation.mock.invocationCallOrder[0]).toBeLessThan(
      itineraryCreate.mock.invocationCallOrder[0]
    )
  })

  it('refuses when the per-period allowance is spent, and writes nothing', async () => {
    claimItineraryCreation.mockResolvedValue({
      allowed: false,
      remaining: 0,
      refusal: {
        reason: 'PERIOD_LIMIT',
        message: 'You have used all 10 itineraries included in Premium 10 this month.',
        upgrade: null,
      },
    })

    await expect(createItineraryFromBrief({ userId: USER_ID, brief: BRIEF })).rejects.toMatchObject(
      {
        status: 403,
        reason: 'PERIOD_LIMIT',
      }
    )
    expect(itineraryCreate).not.toHaveBeenCalled()
  })

  it('hands the allowance back when the generation fails', async () => {
    // Claiming before the work is what makes it race-free; undoing the claim is
    // the price. Without it a catalog outage silently spends a subscriber's
    // tenth itinerary on nothing, with no way to appeal.
    itineraryCreate.mockRejectedValue(new Error('catalog unavailable'))

    await expect(createItineraryFromBrief({ userId: USER_ID, brief: BRIEF })).rejects.toThrow(
      'catalog unavailable'
    )
    expect(releaseItineraryCreation).toHaveBeenCalledWith(USER_ID)
  })

  it('does not claim an allowance for a request it was going to refuse anyway', async () => {
    canGenerateDays.mockResolvedValue({
      maxDays: 0,
      unlimited: false,
      unlocked: false,
      source: 'PLAN',
      entitlement: {} as never,
      refusal: { reason: 'FREE_DAY_LIMIT', message: 'No days.', upgrade: null },
    })

    await expect(createItineraryFromBrief({ userId: USER_ID, brief: BRIEF })).rejects.toMatchObject(
      {
        status: 403,
      }
    )
    expect(claimItineraryCreation).not.toHaveBeenCalled()
  })

  it('generates the whole trip once the itinerary is unlocked', async () => {
    canGenerateDays.mockResolvedValue({
      maxDays: 30,
      unlimited: true,
      unlocked: true,
      source: 'UNLOCK',
      entitlement: {} as never,
      refusal: null,
    })
    itineraryFindFirst.mockResolvedValue(itineraryRow(7))

    const result = await createItineraryFromBrief({ userId: USER_ID, brief: BRIEF })

    const created = itineraryCreate.mock.calls[0][0] as { data: { days: { create: unknown[] } } }
    expect(created.data.days.create).toHaveLength(7)
    expect(result.generatedDays).toBe(7)
    expect(result.allowance.refusal).toBeNull()
  })

  it('refuses outright when the monthly allowance is spent', async () => {
    // The one case with no partial plan to narrate: there is no good half of a
    // zero-day itinerary.
    canGenerateDays.mockResolvedValue({
      maxDays: 0,
      unlimited: false,
      unlocked: false,
      source: 'PLAN',
      entitlement: {} as never,
      refusal: { reason: 'PERIOD_LIMIT', message: 'Allowance spent.', upgrade: null },
    })

    await expect(createItineraryFromBrief({ userId: USER_ID, brief: BRIEF })).rejects.toMatchObject(
      {
        status: 403,
        code: 'FORBIDDEN',
      }
    )
    expect(itineraryCreate).not.toHaveBeenCalled()
  })

  it('refuses a brief with no destination before consulting anything else', async () => {
    await expect(
      createItineraryFromBrief({
        userId: USER_ID,
        brief: { interests: [], mustSee: [], avoid: [] },
      })
    ).rejects.toBeInstanceOf(ApiError)

    expect(itineraryCreate).not.toHaveBeenCalled()
  })
})

describe('regenerateDay — day-limit enforcement', () => {
  beforeEach(() => {
    itineraryFindFirst.mockResolvedValue(itineraryRow(5))
  })

  it('refuses a day beyond the allowance with the structured reason', async () => {
    const failure = await regenerateDay(USER_ID, ITINERARY_ID, 5).catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 403, reason: 'FREE_DAY_LIMIT' })
    // Nothing was rebuilt, so nothing was destroyed on the way to being refused.
    expect(blockDeleteMany).not.toHaveBeenCalled()
  })

  it('rebuilds a day that is inside the allowance', async () => {
    await regenerateDay(USER_ID, ITINERARY_ID, 2)

    expect(blockDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { dayId: 'day-2', isLocked: false } })
    )
  })

  it('404s for a day the itinerary does not have', async () => {
    await expect(regenerateDay(USER_ID, ITINERARY_ID, 9)).rejects.toMatchObject({ status: 404 })
  })
})

describe('block edits — day-limit enforcement', () => {
  /**
   * The lapse scenario, which is the one that costs money.
   *
   * A month of PREMIUM_10 generates ten seven-day itineraries. The subscription
   * ends, `maxItineraryDays` drops back to FREE's 2, and every one of those
   * seventy days used to stay fully editable — so one month bought ten
   * permanently full-length trips, which is exactly what the 200 BDT
   * per-itinerary unlock exists to sell.
   */
  beforeEach(() => {
    itineraryFindFirst.mockResolvedValue({
      ...itineraryRow(7),
      days: itineraryRow(7).days.map((day) => ({
        ...day,
        blocks: [
          {
            id: `block-on-day-${day.dayNumber}`,
            kind: 'ACTIVITY',
            activityId: null,
            title: 'Something',
            description: null,
            startMinute: 540,
            endMinute: 660,
            transitMode: null,
            transitFromBlockId: null,
            isLocked: false,
            isEstimate: false,
            sortOrder: 540,
            costBdt: null,
          },
        ],
      })),
    })
  })

  it('refuses to add a block to a day beyond the allowance', async () => {
    const failure = await addBlock(USER_ID, ITINERARY_ID, 6, {
      kind: 'MEAL',
      startMinute: 720,
      endMinute: 780,
    }).catch((e: unknown) => e)

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure).toMatchObject({ status: 403, reason: 'FREE_DAY_LIMIT' })
    // Building day six one block at a time is still building day six.
    expect(blockCreate).not.toHaveBeenCalled()
  })

  it('still allows a block inside the allowance', async () => {
    await addBlock(USER_ID, ITINERARY_ID, 2, {
      kind: 'MEAL',
      startMinute: 720,
      endMinute: 780,
    })

    expect(blockCreate).toHaveBeenCalled()
  })

  it('refuses to move a block INTO a day beyond the allowance', async () => {
    const failure = await moveBlock(USER_ID, ITINERARY_ID, 'block-on-day-1', {
      dayNumber: 6,
    }).catch((e: unknown) => e)

    expect(failure).toMatchObject({ status: 403, reason: 'FREE_DAY_LIMIT' })
    expect(blockUpdate).not.toHaveBeenCalled()
  })

  it('refuses to move a block OUT OF a day beyond the allowance', async () => {
    // Guarding only the target would leave day six editable from the inside,
    // and would make an out-of-allowance day a doorway rather than a wall.
    const failure = await moveBlock(USER_ID, ITINERARY_ID, 'block-on-day-6', {
      dayNumber: 1,
    }).catch((e: unknown) => e)

    expect(failure).toMatchObject({ status: 403, reason: 'FREE_DAY_LIMIT' })
    expect(blockUpdate).not.toHaveBeenCalled()
  })

  it('refuses to retime a block on a day beyond the allowance', async () => {
    const failure = await moveBlock(USER_ID, ITINERARY_ID, 'block-on-day-5', {
      startMinute: 600,
      endMinute: 700,
    }).catch((e: unknown) => e)

    expect(failure).toMatchObject({ status: 403, reason: 'FREE_DAY_LIMIT' })
  })

  it('still allows a move entirely inside the allowance', async () => {
    await moveBlock(USER_ID, ITINERARY_ID, 'block-on-day-1', { dayNumber: 2 })

    expect(blockUpdate).toHaveBeenCalled()
  })
})

describe('the read side agrees with the write side', () => {
  it('shows only the days the plan currently reaches', async () => {
    // The decision, asserted: a subscription rents access to length. Refusing
    // to WRITE day six while happily SERVING it would have left the leak open,
    // because reading the plan is the whole product.
    itineraryFindFirst.mockResolvedValue(itineraryRow(7))

    const view = await getItinerary(USER_ID, ITINERARY_ID)

    expect(view.days.map((day) => day.dayNumber)).toEqual([1, 2])
    expect(view.plannedDays).toBe(2)
    // Still seven days long. `plannedDays < totalDays` is how a client knows a
    // wall was hit and which offer to render.
    expect(view.totalDays).toBe(7)
  })

  it('shows the whole trip again once the itinerary is unlocked', async () => {
    // Nothing was deleted. The 200 BDT unlock — or a new subscription — brings
    // every generated day back with its edits intact.
    itineraryFindFirst.mockResolvedValue(itineraryRow(7))
    canGenerateDays.mockResolvedValue({
      maxDays: 30,
      unlimited: true,
      unlocked: true,
      source: 'UNLOCK',
      entitlement: {} as never,
      refusal: null,
    })

    const view = await getItinerary(USER_ID, ITINERARY_ID)

    expect(view.days).toHaveLength(7)
    expect(view.plannedDays).toBe(7)
  })
})

describe('saveItinerary', () => {
  it('goes through the atomic claim rather than counting and then writing', async () => {
    const result = await saveItinerary(USER_ID, ITINERARY_ID)

    // The old shape — canSaveItinerary, then an unconditional update — is what
    // let eight concurrent saves all pass a cap of three.
    expect(claimSaveSlot).toHaveBeenCalledWith(USER_ID, ITINERARY_ID)
    expect(itineraryUpdate).not.toHaveBeenCalled()
    expect(result.remaining).toBe(2)
  })

  it('turns a refused claim into a 403 carrying the reason', async () => {
    claimSaveSlot.mockResolvedValue({
      claimed: false,
      decision: {
        allowed: false,
        remaining: 0,
        refusal: {
          reason: 'SAVE_LIMIT',
          message: 'Free keeps 3 saved itineraries at a time.',
          upgrade: null,
        },
      },
    })

    await expect(saveItinerary(USER_ID, ITINERARY_ID)).rejects.toMatchObject({
      status: 403,
      reason: 'SAVE_LIMIT',
    })
  })

  it("404s before claiming anything for somebody else's itinerary", async () => {
    itineraryFindFirst.mockResolvedValue(null)

    await expect(saveItinerary(OTHER_USER_ID, ITINERARY_ID)).rejects.toMatchObject({ status: 404 })
    // "Not yours" and "does not exist" must be indistinguishable, so ownership
    // is answered before the entitlement is even consulted.
    expect(claimSaveSlot).not.toHaveBeenCalled()
  })
})

describe('ownership', () => {
  it('scopes the lookup on the caller, not merely on the id', async () => {
    await getItinerary(USER_ID, ITINERARY_ID)

    expect(itineraryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ITINERARY_ID, userId: USER_ID } })
    )
  })

  it("answers 404 — not 403 — for somebody else's itinerary", async () => {
    // The scoped query simply matches nothing. A 403 would confirm that an id
    // somebody guessed is real.
    itineraryFindFirst.mockResolvedValue(null)

    await expect(getItinerary(OTHER_USER_ID, ITINERARY_ID)).rejects.toMatchObject({ status: 404 })
  })

  it('refuses to regenerate a day of an itinerary the caller does not own', async () => {
    itineraryFindFirst.mockResolvedValue(null)

    await expect(regenerateDay(OTHER_USER_ID, ITINERARY_ID, 1)).rejects.toMatchObject({
      status: 404,
    })
    expect(canGenerateDays).not.toHaveBeenCalled()
  })
})

describe('syncTransitBlocks — transit insertion', () => {
  const activityA = {
    id: 'activity-a',
    kind: 'ACTIVITY',
    activityId: 'activity-a',
    title: 'Beach walk',
    startMinute: 540,
    endMinute: 660,
    isLocked: false,
    isEstimate: false,
    sortOrder: 540,
    costBdt: null,
    description: null,
    transitMode: null,
    transitFromBlockId: null,
  }

  const activityB = {
    ...activityA,
    id: 'activity-b',
    activityId: 'activity-b',
    title: 'Temple',
    startMinute: 780,
    endMinute: 900,
    sortOrder: 780,
  }

  function catalogRows() {
    return new Map([
      ['activity-a', { id: 'activity-a', location: BEACH, openingHours: [], isActive: true }],
      ['activity-b', { id: 'activity-b', location: ACROSS_TOWN, openingHours: [], isActive: true }],
    ])
  }

  it('inserts one estimated transfer between two consecutive activities', async () => {
    dayFindUnique.mockResolvedValue({ blocks: [activityA, activityB] })
    getActivitiesByIds.mockResolvedValue(catalogRows())

    await syncTransitBlocks(DAY_ID, 'PRIVATE_CAR')

    const written = blockCreateMany.mock.calls[0][0] as {
      data: { kind: string; isEstimate: boolean; startMinute: number; transitFromBlockId: string }[]
    }

    expect(written.data).toHaveLength(1)
    expect(written.data[0]).toMatchObject({
      kind: 'TRANSIT',
      isEstimate: true,
      startMinute: 660,
      transitFromBlockId: 'activity-a',
    })
  })

  it('deletes only the transfers it drew itself', async () => {
    // The predicate that protects a ferry somebody booked and typed in.
    dayFindUnique.mockResolvedValue({ blocks: [activityA, activityB] })
    getActivitiesByIds.mockResolvedValue(catalogRows())

    await syncTransitBlocks(DAY_ID, 'PRIVATE_CAR')

    expect(blockDeleteMany).toHaveBeenCalledWith({
      where: { dayId: DAY_ID, kind: 'TRANSIT', isEstimate: true },
    })
  })

  it('inserts nothing when the traveller placed their own transfer between them', async () => {
    dayFindUnique.mockResolvedValue({
      blocks: [
        activityA,
        {
          ...activityA,
          id: 'their-ferry',
          kind: 'TRANSIT',
          activityId: null,
          title: 'Ferry we booked',
          startMinute: 690,
          endMinute: 750,
          isEstimate: false,
        },
        activityB,
      ],
    })
    getActivitiesByIds.mockResolvedValue(catalogRows())

    await syncTransitBlocks(DAY_ID, 'PRIVATE_CAR')

    expect(blockCreateMany).not.toHaveBeenCalled()
  })

  it('inserts nothing when the two activities already touch', async () => {
    dayFindUnique.mockResolvedValue({
      blocks: [activityA, { ...activityB, startMinute: 660, endMinute: 780 }],
    })
    getActivitiesByIds.mockResolvedValue(catalogRows())

    await syncTransitBlocks(DAY_ID, 'PRIVATE_CAR')

    expect(blockCreateMany).not.toHaveBeenCalled()
  })

  it('does nothing at all for a day that no longer exists', async () => {
    dayFindUnique.mockResolvedValue(null)

    await syncTransitBlocks(DAY_ID, 'PRIVATE_CAR')

    expect(blockDeleteMany).not.toHaveBeenCalled()
    expect(blockCreateMany).not.toHaveBeenCalled()
  })
})
