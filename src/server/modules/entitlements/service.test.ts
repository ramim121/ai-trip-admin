import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetEnvCache } from '@/lib/env'
import { MAX_TRIP_DAYS } from '@/server/ai/schemas'
import { clearSettingCache } from '@/server/settings/read'
import {
  DEFAULT_UNLOCK_PRICE_BDT,
  FREE_AI_PROMPTS_PER_PERIOD,
  anonymousActor,
  canGenerateDays,
  canPrompt,
  canSaveItinerary,
  claimItineraryCreation,
  claimSaveSlot,
  daysToGenerate,
  entitlementRefused,
  recordUsage,
  releaseItineraryCreation,
  resolveEntitlement,
  resolvePeriod,
  toPromptEntitlement,
  userActor,
} from './service'

/**
 * The limit logic, with the database mocked wholesale.
 *
 * These tests are about *decisions* — which check runs, in what order, and what
 * it answers — so a real Postgres would add flakiness and hide the assertions
 * that matter. What is deliberately not mocked is the arithmetic: period
 * boundaries, remaining counts and the null-means-unlimited rule are computed
 * for real, because those are the parts that break quietly.
 *
 * The case worth naming is the null trap. `saved >= plan.maxSavedItineraries`
 * with a null limit is `saved >= 0`, which is true, which would turn the most
 * expensive tier into the most restrictive one. Several tests below exist only
 * to stop that ever shipping.
 *
 * The second thing mocking cannot be allowed to hide is the difference between
 * checking a limit and CLAIMING it. `canSaveItinerary` and `canPrompt` are
 * advisory reads; `claimSaveSlot` and `claimItineraryCreation` are the writes
 * that enforce. The tests for the claims assert on the shape of the statement —
 * that the ceiling is in the WHERE clause and not in a JavaScript comparison —
 * because that shape is the entire difference between a cap and a suggestion.
 */

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    subscription: { findFirst: vi.fn() },
    plan: { findUnique: vi.fn() },
    itinerary: { count: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    usageCounter: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
    itineraryUnlock: { findUnique: vi.fn() },
    anonymousVisitor: { findUnique: vi.fn() },
    setting: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}))

vi.mock('@/lib/db', () => ({ db: mockDb, disconnectDb: vi.fn() }))

process.env.DATABASE_URL =
  'postgresql://tester:not-a-real-password@localhost:5432/beyond_borders_test'
process.env.AUTH_USER_SECRET = 'test-user-secret-0123456789-abcdefghij'
process.env.AUTH_ADMIN_SECRET = 'test-admin-secret-0123456789-abcdefghij'
resetEnvCache()

const USER_ID = '019373d4-4a1b-7c3e-9f00-1111aaaa0001'
const ITINERARY_ID = '019373d4-4a1b-7c3e-9f00-6666ffff0006'
const VISITOR_ID = '019373d4-4a1b-7c3e-9f00-7777aaaa0007'

const FREE_PLAN = {
  code: 'FREE' as const,
  name: 'Free',
  maxItineraryDays: 2 as number | null,
  maxSavedItineraries: 3 as number | null,
  itinerariesPerPeriod: null as number | null,
  aiPromptsPerPeriod: FREE_AI_PROMPTS_PER_PERIOD as number | null,
}

const PREMIUM_10 = {
  code: 'PREMIUM_10' as const,
  name: 'Premium 10',
  maxItineraryDays: null as number | null,
  maxSavedItineraries: null as number | null,
  itinerariesPerPeriod: 10 as number | null,
  aiPromptsPerPeriod: 150 as number | null,
}

/** A tier with no ceiling of any kind — the shape the null trap preys on. */
const UNMETERED_PLAN = {
  ...PREMIUM_10,
  code: 'PREMIUM_100' as const,
  name: 'Premium 100',
  itinerariesPerPeriod: null as number | null,
  aiPromptsPerPeriod: null as number | null,
}

/** Mid-month, so a calendar-month boundary is unambiguous in the assertions. */
const NOW = new Date(Date.UTC(2026, 6, 15, 9, 0, 0))

const PERIOD_END = new Date(Date.UTC(2026, 7, 1))

/**
 * The plan shape `resolveEntitlement` reads.
 *
 * `code` is widened to string deliberately: pinning it to `typeof PREMIUM_10`
 * fixes the literal to that one tier, so any case exercising PREMIUM_100 or
 * UNLOCK_SINGLE fails to typecheck for a reason that has nothing to do with
 * what it is testing. The limits are what these cases are about.
 */
type TestPlan = Omit<typeof PREMIUM_10, 'code'> & { code: string }

interface WorldOptions {
  subscription?: { id: string; currentPeriodEnd: Date; plan: TestPlan } | null
  freePlan?: typeof FREE_PLAN | null
  savedCount?: number
  counter?: { itinerariesCreated: number; aiPromptsUsed: number } | null
  unlock?: { id: string } | null
  visitor?: { promptsUsed: number } | null
  promptLimitSetting?: number | null
}

/** One place to describe the database each case is asking about. */
function world(options: WorldOptions = {}): void {
  mockDb.usageCounter.upsert.mockResolvedValue({ id: 'counter-1' })
  mockDb.usageCounter.updateMany.mockResolvedValue({ count: 1 })
  mockDb.itinerary.updateMany.mockResolvedValue({ count: 1 })
  mockDb.itinerary.findFirst.mockResolvedValue({ status: 'DRAFT' })
  mockDb.$transaction.mockImplementation(
    async (fn: (tx: typeof mockDb) => Promise<unknown>) => fn(mockDb)
  )
  mockDb.subscription.findFirst.mockResolvedValue(options.subscription ?? null)
  mockDb.plan.findUnique.mockResolvedValue(
    options.freePlan === undefined ? FREE_PLAN : options.freePlan
  )
  mockDb.itinerary.count.mockResolvedValue(options.savedCount ?? 0)
  mockDb.usageCounter.findUnique.mockResolvedValue(options.counter ?? null)
  mockDb.itineraryUnlock.findUnique.mockResolvedValue(options.unlock ?? null)
  mockDb.anonymousVisitor.findUnique.mockResolvedValue(options.visitor ?? null)

  // Every settings read goes through one delegate; the unlock price and the
  // anonymous prompt limit are told apart by key.
  mockDb.setting.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => {
    if (where.key === 'ai.teaser.promptLimit') {
      return options.promptLimitSetting === undefined ? null : { value: options.promptLimitSetting }
    }
    return null
  })
}

/** Narrowing helper, so a refusal assertion does not need a non-null assertion. */
function refusalOf(decision: Awaited<ReturnType<typeof canPrompt>>) {
  if (decision.allowed) throw new Error('expected a refusal, got an allowance')
  return decision.refusal
}

beforeEach(() => {
  vi.clearAllMocks()
  // Settings are cached for 30s, which would otherwise leak one case's
  // configuration into the next.
  clearSettingCache()
  world()
})

describe('resolveEntitlement', () => {
  it('answers for an anonymous visitor without touching the database', async () => {
    const entitlement = await resolveEntitlement(null, NOW)

    expect(entitlement.isAnonymous).toBe(true)
    expect(entitlement.maxItineraryDays).toBe(0)
    expect(entitlement.maxSavedItineraries).toBe(0)
    expect(entitlement.itinerariesPerPeriod).toBe(0)
    expect(mockDb.subscription.findFirst).not.toHaveBeenCalled()
    expect(mockDb.plan.findUnique).not.toHaveBeenCalled()
  })

  it('gives an anonymous visitor zero allowances rather than the free tier', async () => {
    // The tempting default is FREE's 2 days and 3 saves. That hands an
    // account's worth of product to somebody who never made one.
    const entitlement = await resolveEntitlement(null, NOW)

    expect(entitlement.maxItineraryDays).not.toBe(FREE_PLAN.maxItineraryDays)
    expect(entitlement.maxSavedItineraries).not.toBe(FREE_PLAN.maxSavedItineraries)
  })

  it('falls back to FREE when the account has no subscription', async () => {
    world({ savedCount: 1 })

    const entitlement = await resolveEntitlement(USER_ID, NOW)

    expect(entitlement.planCode).toBe('FREE')
    expect(entitlement.maxItineraryDays).toBe(2)
    expect(entitlement.maxSavedItineraries).toBe(3)
    expect(entitlement.subscriptionId).toBeNull()
    expect(entitlement.savedCount).toBe(1)
  })

  it('only considers subscriptions that are ACTIVE and still inside their period', async () => {
    await resolveEntitlement(USER_ID, NOW)

    const query = mockDb.subscription.findFirst.mock.lastCall?.[0] as {
      where: { status: string; currentPeriodEnd: { gt: Date } }
    }

    // Expiry is a WHERE clause, not an if-statement somebody can forget: a
    // lapsed row simply never matches, so the fallback to FREE is silent.
    expect(query.where.status).toBe('ACTIVE')
    expect(query.where.currentPeriodEnd.gt).toEqual(NOW)
  })

  it('excludes one-off plans from the subscription lookup entirely', async () => {
    await resolveEntitlement(USER_ID, NOW)

    const query = mockDb.subscription.findFirst.mock.lastCall?.[0] as {
      where: { plan: { interval: { not: string } } }
    }

    // UNLOCK_SINGLE is a Plan row with interval NONE and a sortOrder that
    // outranks FREE. A payment handler creating a Subscription from
    // `upgrade.planCode` on settlement — the obvious implementation, and the
    // planCode unlockOffer publishes — would otherwise turn one 200 BDT purchase
    // into a permanent account-wide upgrade. The invariant lives in the query so
    // that no such handler can be written wrongly.
    expect(query.where.plan).toEqual({ interval: { not: 'NONE' } })
  })

  it('reads the AI prompt ceiling from the plan', async () => {
    world({ subscription: { id: 'sub-1', currentPeriodEnd: PERIOD_END, plan: PREMIUM_10 } })

    const entitlement = await resolveEntitlement(USER_ID, NOW)

    expect(entitlement.aiPromptsPerPeriod).toBe(150)
  })

  it('falls back to the free ceiling for AI prompts when the plan row is missing', async () => {
    // The strictest tier, never the loosest: an unseeded database must not read
    // as "unlimited model calls".
    world({ freePlan: null })

    const entitlement = await resolveEntitlement(USER_ID, NOW)

    expect(entitlement.aiPromptsPerPeriod).toBe(FREE_AI_PROMPTS_PER_PERIOD)
  })

  it('uses the subscribed plan when one is live', async () => {
    world({
      subscription: { id: 'sub-1', currentPeriodEnd: PERIOD_END, plan: PREMIUM_10 },
      counter: { itinerariesCreated: 4, aiPromptsUsed: 9 },
    })

    const entitlement = await resolveEntitlement(USER_ID, NOW)

    expect(entitlement.planCode).toBe('PREMIUM_10')
    expect(entitlement.maxItineraryDays).toBeNull()
    expect(entitlement.itinerariesPerPeriod).toBe(10)
    expect(entitlement.subscriptionId).toBe('sub-1')
    expect(entitlement.periodUsage).toEqual({ itinerariesCreated: 4, aiPromptsUsed: 9 })
  })

  it('falls back to the strictest tier when the FREE plan row is missing', async () => {
    // An unseeded or half-migrated database must not read as "no limits".
    world({ freePlan: null })

    const entitlement = await resolveEntitlement(USER_ID, NOW)

    expect(entitlement.maxItineraryDays).toBe(2)
    expect(entitlement.maxSavedItineraries).toBe(3)
    expect(entitlement.itinerariesPerPeriod).toBeNull()
  })

  it('does not confuse a missing plan row with a plan that says unlimited', async () => {
    world({ subscription: { id: 'sub-1', currentPeriodEnd: PERIOD_END, plan: PREMIUM_10 } })

    const entitlement = await resolveEntitlement(USER_ID, NOW)

    // `plan?.maxItineraryDays ?? FALLBACK` would produce 2 here, silently
    // downgrading every premium account to the free tier's cap.
    expect(entitlement.maxItineraryDays).toBeNull()
  })
})

describe('resolvePeriod', () => {
  it('meters an account with no subscription on the UTC calendar month', () => {
    const { start, end } = resolvePeriod(NOW, null)

    expect(start.toISOString()).toBe('2026-07-01T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-08-01T00:00:00.000Z')
  })

  it('meters a subscriber on their billing month', () => {
    const periodEnd = new Date(Date.UTC(2026, 7, 15, 6, 30))
    const { start, end } = resolvePeriod(NOW, periodEnd)

    expect(start.toISOString()).toBe('2026-07-15T06:30:00.000Z')
    expect(end).toBe(periodEnd)
  })

  it('clamps rather than overflowing when the previous month is shorter', () => {
    // A naive setUTCMonth(-1) on 31 March lands on 3 March, which would make
    // the period key wander and orphan the usage counter it belongs to.
    const periodEnd = new Date(Date.UTC(2026, 2, 31, 0, 0))
    const { start } = resolvePeriod(NOW, periodEnd)

    expect(start.toISOString()).toBe('2026-02-28T00:00:00.000Z')
  })
})

describe('canGenerateDays', () => {
  it('caps a FREE account at two days and says why', async () => {
    const allowance = await canGenerateDays(userActor(USER_ID), ITINERARY_ID)

    expect(allowance.maxDays).toBe(2)
    expect(allowance.unlimited).toBe(false)
    expect(allowance.refusal?.reason).toBe('FREE_DAY_LIMIT')
    expect(allowance.refusal?.upgrade?.action).toBe('UNLOCK_ITINERARY')
    expect(allowance.refusal?.upgrade?.itineraryId).toBe(ITINERARY_ID)
    expect(allowance.refusal?.upgrade?.priceBdt).toBe(DEFAULT_UNLOCK_PRICE_BDT)
  })

  it('lifts the cap for an itinerary that has been unlocked', async () => {
    world({ unlock: { id: 'unlock-1' } })

    const allowance = await canGenerateDays(userActor(USER_ID), ITINERARY_ID)

    expect(allowance.unlocked).toBe(true)
    expect(allowance.maxDays).toBe(MAX_TRIP_DAYS)
    expect(allowance.source).toBe('UNLOCK')
    expect(allowance.refusal).toBeNull()
  })

  it('reads the unlock from ItineraryUnlock, never from a flag on the itinerary', async () => {
    world({ unlock: { id: 'unlock-1' } })

    await canGenerateDays(userActor(USER_ID), ITINERARY_ID)

    // Itinerary.isFullyUnlocked is a denormalised cache; trusting it here would
    // turn a stale write into a free upgrade.
    expect(mockDb.itineraryUnlock.findUnique).toHaveBeenCalledWith({
      where: { userId_itineraryId: { userId: USER_ID, itineraryId: ITINERARY_ID } },
      select: { id: true },
    })
  })

  it('lets an uncapped subscription cover the whole trip', async () => {
    world({ subscription: { id: 'sub-1', currentPeriodEnd: PERIOD_END, plan: PREMIUM_10 } })

    const allowance = await canGenerateDays(userActor(USER_ID), ITINERARY_ID)

    expect(allowance.maxDays).toBe(MAX_TRIP_DAYS)
    expect(allowance.source).toBe('SUBSCRIPTION')
    expect(allowance.refusal).toBeNull()
  })

  it('gives an anonymous visitor no days at all', async () => {
    const allowance = await canGenerateDays(anonymousActor(VISITOR_ID))

    expect(allowance.maxDays).toBe(0)
    expect(allowance.source).toBe('ANONYMOUS')
    expect(allowance.refusal?.upgrade?.action).toBe('SIGN_IN')
    // No unlock lookup for somebody who cannot own an itinerary.
    expect(mockDb.itineraryUnlock.findUnique).not.toHaveBeenCalled()
  })

  it('applies the plan cap when no itinerary exists yet', async () => {
    const allowance = await canGenerateDays(userActor(USER_ID))

    expect(allowance.maxDays).toBe(2)
    // Nothing exists to have been unlocked, so nothing is looked up.
    expect(mockDb.itineraryUnlock.findUnique).not.toHaveBeenCalled()
    expect(allowance.refusal?.upgrade?.action).toBe('SUBSCRIBE')
  })

  it('clamps a client-supplied day count to the allowance', async () => {
    const allowance = await canGenerateDays(userActor(USER_ID), ITINERARY_ID)

    // The hostile case: the client asks for thirty days on a two-day plan.
    expect(daysToGenerate(30, allowance)).toBe(2)
    expect(daysToGenerate(1, allowance)).toBe(1)
    expect(daysToGenerate(-5, allowance)).toBe(0)
    expect(daysToGenerate(2.9, allowance)).toBe(2)
  })
})

describe('canSaveItinerary', () => {
  it('blocks a FREE account at three saved', async () => {
    world({ savedCount: 3 })

    const decision = await canSaveItinerary(userActor(USER_ID))

    expect(decision.allowed).toBe(false)
    expect(refusalOf(decision).reason).toBe('SAVE_LIMIT')
    expect(refusalOf(decision).upgrade?.action).toBe('SUBSCRIBE')
  })

  it('allows the third save and reports what is left', async () => {
    world({ savedCount: 2 })

    const decision = await canSaveItinerary(userActor(USER_ID))

    expect(decision.allowed).toBe(true)
    if (!decision.allowed) throw new Error('expected an allowance')
    expect(decision.remaining).toBe(1)
  })

  it('does not charge a slot for an itinerary that already holds one', async () => {
    world({ savedCount: 3 })

    const decision = await canSaveItinerary(userActor(USER_ID), { alreadySaved: true })

    // Otherwise editing a trip is impossible for exactly the accounts most
    // likely to be sitting at the cap.
    expect(decision.allowed).toBe(true)
  })

  it('treats a null saved limit as unlimited, not as zero', async () => {
    world({
      subscription: { id: 'sub-1', currentPeriodEnd: PERIOD_END, plan: PREMIUM_10 },
      savedCount: 250,
      counter: { itinerariesCreated: 0, aiPromptsUsed: 0 },
    })

    const decision = await canSaveItinerary(userActor(USER_ID))

    expect(decision.allowed).toBe(true)
    if (!decision.allowed) throw new Error('expected an allowance')
    // Bounded by the period allowance, the only ceiling this plan actually has.
    expect(decision.remaining).toBe(10)
  })

  it('blocks a premium account that has spent its period allowance', async () => {
    world({
      subscription: { id: 'sub-1', currentPeriodEnd: PERIOD_END, plan: PREMIUM_10 },
      counter: { itinerariesCreated: 10, aiPromptsUsed: 0 },
    })

    const decision = await canSaveItinerary(userActor(USER_ID))

    expect(decision.allowed).toBe(false)
    // Distinct from SAVE_LIMIT on purpose: one says "delete one", the other
    // says "wait for the reset", and they need different copy.
    expect(refusalOf(decision).reason).toBe('PERIOD_LIMIT')
  })

  it('refuses an anonymous visitor with an invitation to sign in', async () => {
    const decision = await canSaveItinerary(anonymousActor(VISITOR_ID))

    expect(decision.allowed).toBe(false)
    expect(refusalOf(decision).reason).toBe('SAVE_LIMIT')
    expect(refusalOf(decision).upgrade?.action).toBe('SIGN_IN')
    expect(refusalOf(decision).upgrade?.priceBdt).toBe(0)
  })
})

describe('claimSaveSlot', () => {
  /**
   * A database that serialises transactions, backed by an in-memory table.
   *
   * The mock serialises the callbacks because that is precisely what
   * `isolationLevel: 'Serializable'` buys, whether Postgres delivers it by
   * aborting the loser (and the retry loop re-running it against committed
   * state) or by ordering them. What the mock deliberately does NOT model is the
   * cap: `count` returns whatever the table actually holds. So an implementation
   * that counted OUTSIDE the transaction — as the old one did, via
   * canSaveItinerary — would see the same stale zero eight times over and let
   * all eight through. That is the difference this fixture is here to detect.
   */
  function serialisedItineraryTable(ids: readonly string[]): { savedCount: () => number } {
    const status = new Map<string, string>(ids.map((id) => [id, 'DRAFT']))
    const saved = ['SAVED', 'SUBMITTED', 'QUOTED', 'ACCEPTED', 'BOOKED', 'COMPLETED']

    const tx = {
      itinerary: {
        findFirst: ({ where }: { where: { id: string } }) =>
          Promise.resolve(status.has(where.id) ? { status: status.get(where.id) } : null),
        count: () =>
          Promise.resolve([...status.values()].filter((s) => saved.includes(s)).length),
        updateMany: ({
          where,
          data,
        }: {
          where: { id: string; status: string }
          data: { status: string }
        }) => {
          if (status.get(where.id) !== where.status) return Promise.resolve({ count: 0 })
          status.set(where.id, data.status)
          return Promise.resolve({ count: 1 })
        },
      },
    }

    // One at a time, and the next one only starts once the previous has
    // committed — which is what makes the count inside it a fresh count.
    let queue: Promise<unknown> = Promise.resolve()
    mockDb.$transaction.mockImplementation((fn: (client: typeof tx) => Promise<unknown>) => {
      const run = queue.then(() => fn(tx))
      queue = run.then(
        () => undefined,
        () => undefined
      )
      return run
    })

    return { savedCount: () => [...status.values()].filter((s) => saved.includes(s)).length }
  }

  it('keeps a FREE account to exactly three saves under eight concurrent requests', async () => {
    // The attack, in full: creation is uncapped, so eight DRAFTs cost nothing,
    // and eight simultaneous POSTs to /itineraries/{id}/save used to have all
    // eight read savedCount=0, all eight pass a cap of 3, and all eight write.
    const ids = Array.from({ length: 8 }, (_, index) => `itinerary-${index + 1}`)

    // What the ADVISORY read outside the transaction sees. Deliberately stale
    // at zero for every one of the eight — if that number decided anything, the
    // cap would be eight.
    world({ savedCount: 0 })
    const table = serialisedItineraryTable(ids)

    const outcomes = await Promise.all(ids.map((id) => claimSaveSlot(USER_ID, id)))

    expect(table.savedCount()).toBe(3)
    expect(outcomes.filter((outcome) => outcome.claimed)).toHaveLength(3)
    expect(outcomes.filter((outcome) => !outcome.decision.allowed)).toHaveLength(5)
  })

  it('refuses the losers with SAVE_LIMIT and an offer, not with a shrug', async () => {
    const ids = Array.from({ length: 5 }, (_, index) => `itinerary-${index + 1}`)
    world({ savedCount: 0 })
    serialisedItineraryTable(ids)

    const outcomes = await Promise.all(ids.map((id) => claimSaveSlot(USER_ID, id)))
    const refused = outcomes.filter((outcome) => !outcome.decision.allowed)

    for (const outcome of refused) {
      if (outcome.decision.allowed) throw new Error('expected a refusal')
      expect(outcome.decision.refusal.reason).toBe('SAVE_LIMIT')
      expect(outcome.decision.refusal.upgrade?.action).toBe('SUBSCRIBE')
    }
  })

  it('runs the count and the write in one Serializable transaction', async () => {
    await claimSaveSlot(USER_ID, ITINERARY_ID)

    // Not a stylistic preference. Read-then-write outside a transaction is the
    // defect; the isolation level is what makes the re-count binding.
    expect(mockDb.$transaction.mock.lastCall?.[1]).toEqual({ isolationLevel: 'Serializable' })
  })

  it('predicates the write on the itinerary still being a DRAFT', async () => {
    await claimSaveSlot(USER_ID, ITINERARY_ID)

    const call = mockDb.itinerary.updateMany.mock.lastCall?.[0] as {
      where: { id: string; userId: string; status: string }
      data: { status: string }
    }

    // Scoped on the owner as well as the id, so this can never save a
    // stranger's trip, and on DRAFT so a duplicate request consumes nothing.
    expect(call.where).toEqual({ id: ITINERARY_ID, userId: USER_ID, status: 'DRAFT' })
    expect(call.data).toEqual({ status: 'SAVED' })
  })

  it('claims nothing for an itinerary that is already saved', async () => {
    world({ savedCount: 3 })
    mockDb.itinerary.findFirst.mockResolvedValue({ status: 'SAVED' })

    const outcome = await claimSaveSlot(USER_ID, ITINERARY_ID)

    // At the cap and still allowed: it is not a fourth of three. Refusing here
    // would leave the accounts most likely to be at the cap unable to touch the
    // trips they already have.
    expect(outcome.decision.allowed).toBe(true)
    expect(outcome.claimed).toBe(false)
    expect(mockDb.itinerary.updateMany).not.toHaveBeenCalled()
  })

  it('404s rather than consuming a slot for an itinerary that vanished', async () => {
    mockDb.itinerary.findFirst.mockResolvedValue(null)

    await expect(claimSaveSlot(USER_ID, ITINERARY_ID)).rejects.toMatchObject({ status: 404 })
    expect(mockDb.itinerary.updateMany).not.toHaveBeenCalled()
  })
})

describe('claimItineraryCreation', () => {
  it('puts the period ceiling in the WHERE clause, not in a comparison', async () => {
    world({
      subscription: { id: 'sub-1', currentPeriodEnd: PERIOD_END, plan: PREMIUM_10 },
      counter: { itinerariesCreated: 3, aiPromptsUsed: 20 },
    })

    await claimItineraryCreation(USER_ID, NOW)

    const call = mockDb.usageCounter.updateMany.mock.lastCall?.[0] as {
      where: { itinerariesCreated: { lt: number }; aiPromptsUsed: { lt: number } }
      data: { itinerariesCreated: { increment: number }; aiPromptsUsed: { increment: number } }
    }

    // Postgres re-evaluates this under a row lock, which is the only reason two
    // concurrent generations at 9 of 10 cannot both succeed.
    expect(call.where.itinerariesCreated).toEqual({ lt: 10 })
    expect(call.where.aiPromptsUsed).toEqual({ lt: 150 })
    expect(call.data.itinerariesCreated).toEqual({ increment: 1 })
    expect(call.data.aiPromptsUsed).toEqual({ increment: 1 })
  })

  it('refuses when the claim affects no rows', async () => {
    world({
      subscription: { id: 'sub-1', currentPeriodEnd: PERIOD_END, plan: PREMIUM_10 },
      counter: { itinerariesCreated: 10, aiPromptsUsed: 30 },
    })
    mockDb.usageCounter.updateMany.mockResolvedValue({ count: 0 })
    mockDb.usageCounter.findUnique.mockResolvedValue({ itinerariesCreated: 10, aiPromptsUsed: 30 })

    const decision = await claimItineraryCreation(USER_ID, NOW)

    // Zero rows affected is a refusal. This is the wall a PREMIUM_10 subscriber
    // never met: `canGenerateDays` only reads `maxItineraryDays`, every premium
    // tier seeds that null, and so the per-period allowance was enforced
    // nowhere that could actually produce an itinerary.
    expect(decision.allowed).toBe(false)
    expect(refusalOf(decision).reason).toBe('PERIOD_LIMIT')
    expect(refusalOf(decision).message).toContain('10 itineraries')
  })

  it('names the AI ceiling when that is the one that refused', async () => {
    world({ counter: { itinerariesCreated: 0, aiPromptsUsed: FREE_AI_PROMPTS_PER_PERIOD } })
    mockDb.usageCounter.updateMany.mockResolvedValue({ count: 0 })
    mockDb.usageCounter.findUnique.mockResolvedValue({
      itinerariesCreated: 0,
      aiPromptsUsed: FREE_AI_PROMPTS_PER_PERIOD,
    })

    const decision = await claimItineraryCreation(USER_ID, NOW)

    expect(decision.allowed).toBe(false)
    expect(refusalOf(decision).message).toContain('planner messages')
  })

  it('meters a FREE account against prompts even though it has no itinerary ceiling', async () => {
    world({ counter: { itinerariesCreated: 0, aiPromptsUsed: 1 } })

    await claimItineraryCreation(USER_ID, NOW)

    const call = mockDb.usageCounter.updateMany.mock.lastCall?.[0] as {
      where: Record<string, unknown>
    }

    // The null limit is left out of the predicate rather than compared against.
    expect(call.where.itinerariesCreated).toBeUndefined()
    expect(call.where.aiPromptsUsed).toEqual({ lt: FREE_AI_PROMPTS_PER_PERIOD })
  })

  it('creates the counter row first, so a first generation is not refused', async () => {
    world({ counter: null })

    await claimItineraryCreation(USER_ID, NOW)

    // A predicate needs a row to bite on. Without this the very first
    // generation of a period matches nothing and is refused for having spent an
    // allowance it has not touched.
    const upsert = mockDb.usageCounter.upsert.mock.lastCall?.[0] as {
      where: { userId_periodStart: { periodStart: Date } }
    }
    expect(upsert.where.userId_periodStart.periodStart.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z'
    )
    expect(mockDb.usageCounter.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.usageCounter.updateMany.mock.invocationCallOrder[0]
    )
  })

  it('records without a predicate when the plan has no ceiling at all', async () => {
    world({
      subscription: { id: 'sub-1', currentPeriodEnd: PERIOD_END, plan: UNMETERED_PLAN },
      counter: { itinerariesCreated: 500, aiPromptsUsed: 5000 },
    })

    const decision = await claimItineraryCreation(USER_ID, NOW)

    expect(decision.allowed).toBe(true)
    if (!decision.allowed) throw new Error('expected an allowance')
    expect(decision.remaining).toBeNull()
    // Nothing to claim against, so it is a plain increment and not a claim.
    expect(mockDb.usageCounter.updateMany).not.toHaveBeenCalled()
    expect(mockDb.usageCounter.upsert).toHaveBeenCalled()
  })
})

describe('releaseItineraryCreation', () => {
  it('hands the allowance back without letting a counter go negative', async () => {
    await releaseItineraryCreation(USER_ID, NOW)

    const call = mockDb.usageCounter.updateMany.mock.lastCall?.[0] as {
      where: { itinerariesCreated: { gt: number }; aiPromptsUsed: { gt: number } }
      data: { itinerariesCreated: { decrement: number }; aiPromptsUsed: { decrement: number } }
    }

    // The allowance is claimed before the work, so a failure has to be undone —
    // and the guard is what stops the undo becoming a way to mint allowance.
    expect(call.where.itinerariesCreated).toEqual({ gt: 0 })
    expect(call.where.aiPromptsUsed).toEqual({ gt: 0 })
    expect(call.data.itinerariesCreated).toEqual({ decrement: 1 })
    expect(call.data.aiPromptsUsed).toEqual({ decrement: 1 })
  })
})

describe('canPrompt', () => {
  it('allows an anonymous visitor their first and only prompt', async () => {
    world({ visitor: { promptsUsed: 0 } })

    const decision = await canPrompt(anonymousActor(VISITOR_ID))

    expect(decision.allowed).toBe(true)
    if (!decision.allowed) throw new Error('expected an allowance')
    expect(decision.remaining).toBe(1)
  })

  it('refuses the second one', async () => {
    world({ visitor: { promptsUsed: 1 } })

    const decision = await canPrompt(anonymousActor(VISITOR_ID))

    expect(decision.allowed).toBe(false)
    expect(refusalOf(decision).reason).toBe('ANON_PROMPT_EXHAUSTED')
    expect(refusalOf(decision).upgrade?.action).toBe('SIGN_IN')
  })

  it('refuses a visitor who could not be identified', async () => {
    const decision = await canPrompt(anonymousActor(null))

    // Fail closed: an unidentifiable caller is the one case where handing out a
    // free generation is definitely wrong.
    expect(decision.allowed).toBe(false)
  })

  it('refuses a visitor id that resolves to no row', async () => {
    world({ visitor: null })

    const decision = await canPrompt(anonymousActor(VISITOR_ID))

    expect(decision.allowed).toBe(false)
  })

  it('honours an ops-configured limit', async () => {
    world({ visitor: { promptsUsed: 1 }, promptLimitSetting: 3 })

    const decision = await canPrompt(anonymousActor(VISITOR_ID))

    expect(decision.allowed).toBe(true)
    if (!decision.allowed) throw new Error('expected an allowance')
    expect(decision.remaining).toBe(2)
  })

  it('ignores a nonsense limit rather than failing open', async () => {
    // 9999 is past the configurable ceiling, so the row is discarded and the
    // constant applies.
    world({ visitor: { promptsUsed: 1 }, promptLimitSetting: 9999 })

    const decision = await canPrompt(anonymousActor(VISITOR_ID))

    expect(decision.allowed).toBe(false)
  })

  it('meters a FREE account against its AI prompt ceiling', async () => {
    // This used to assert `remaining === null`, which is what the bug looked
    // like from the inside: FREE seeds `itinerariesPerPeriod: null`, canPrompt
    // metered only that, and so every free account passed forever while
    // `aiPromptsUsed` was a column nothing read. The saved-itinerary cap bounds
    // what a free account may KEEP; nothing bounded what it could ASK, and
    // asking is what costs money.
    world({ counter: { itinerariesCreated: 0, aiPromptsUsed: 4 } })

    const decision = await canPrompt(userActor(USER_ID))

    expect(decision.allowed).toBe(true)
    if (!decision.allowed) throw new Error('expected an allowance')
    expect(decision.remaining).toBe(FREE_AI_PROMPTS_PER_PERIOD - 4)
  })

  it('stops a FREE account that has spent its prompts for the month', async () => {
    world({ counter: { itinerariesCreated: 0, aiPromptsUsed: FREE_AI_PROMPTS_PER_PERIOD } })

    const decision = await canPrompt(userActor(USER_ID))

    expect(decision.allowed).toBe(false)
    expect(refusalOf(decision).reason).toBe('PERIOD_LIMIT')
    // The wording names the wall that was actually hit — messages, not trips.
    expect(refusalOf(decision).message).toContain('planner messages')
  })

  it('leaves a plan with no ceiling of either kind genuinely unmetered', async () => {
    // The null trap in the other direction: a tier we deliberately do not meter
    // must not be turned into a tier with a ceiling of zero.
    world({
      subscription: { id: 'sub-1', currentPeriodEnd: PERIOD_END, plan: UNMETERED_PLAN },
      counter: { itinerariesCreated: 900, aiPromptsUsed: 9000 },
    })

    const decision = await canPrompt(userActor(USER_ID))

    expect(decision.allowed).toBe(true)
    if (!decision.allowed) throw new Error('expected an allowance')
    expect(decision.remaining).toBeNull()
  })

  it('stops a premium account that has spent its month', async () => {
    world({
      subscription: { id: 'sub-1', currentPeriodEnd: PERIOD_END, plan: PREMIUM_10 },
      counter: { itinerariesCreated: 10, aiPromptsUsed: 40 },
    })

    const decision = await canPrompt(userActor(USER_ID))

    expect(decision.allowed).toBe(false)
    expect(refusalOf(decision).reason).toBe('PERIOD_LIMIT')
    expect(refusalOf(decision).message).toContain('itineraries')
  })

  it('reports whichever of the two ceilings binds first', async () => {
    world({
      subscription: { id: 'sub-1', currentPeriodEnd: PERIOD_END, plan: PREMIUM_10 },
      counter: { itinerariesCreated: 8, aiPromptsUsed: 149 },
    })

    const decision = await canPrompt(userActor(USER_ID))

    expect(decision.allowed).toBe(true)
    if (!decision.allowed) throw new Error('expected an allowance')
    // 2 itineraries left, 1 prompt left. The prompt is what runs out first.
    expect(decision.remaining).toBe(1)
  })
})

describe('entitlementRefused', () => {
  it('carries the reason code where a client can branch on it', () => {
    const error = entitlementRefused({
      reason: 'ANON_PROMPT_EXHAUSTED',
      message: 'You have used your free preview.',
      upgrade: null,
    })

    expect(error.status).toBe(403)
    expect(error.code).toBe('FORBIDDEN')
    expect(error.reason).toBe('ANON_PROMPT_EXHAUSTED')
    // `details` is the only machine-readable slot the shared error envelope has.
    expect(error.details).toEqual([{ path: 'reason', message: 'ANON_PROMPT_EXHAUSTED' }])
  })
})

describe('recordUsage', () => {
  it('keeps working for a bare prompt increment', async () => {
    // The signature the planner chat path calls. Metering a turn must not
    // require knowing anything about itineraries.
    await recordUsage(USER_ID, { aiPromptsUsed: 1 }, NOW)

    const call = mockDb.usageCounter.upsert.mock.lastCall?.[0] as {
      update: { itinerariesCreated: { increment: number }; aiPromptsUsed: { increment: number } }
    }

    expect(call.update.aiPromptsUsed).toEqual({ increment: 1 })
    expect(call.update.itinerariesCreated).toEqual({ increment: 0 })
  })

  it('excludes one-off plans when deciding which period to write into', async () => {
    await recordUsage(USER_ID, { aiPromptsUsed: 1 }, NOW)

    const query = mockDb.subscription.findFirst.mock.lastCall?.[0] as {
      where: { plan: { interval: { not: string } } }
    }

    // The same clause as `resolveEntitlement`. A counter keyed on a period that
    // the entitlement lookup does not agree with is a counter no ceiling can be
    // enforced against.
    expect(query.where.plan).toEqual({ interval: { not: 'NONE' } })
  })

  it('increments rather than overwriting', async () => {
    mockDb.usageCounter.upsert.mockResolvedValue({ id: 'counter-1' })

    await recordUsage(USER_ID, { itinerariesCreated: 1, aiPromptsUsed: 1 }, NOW)

    const call = mockDb.usageCounter.upsert.mock.lastCall?.[0] as {
      where: { userId_periodStart: { userId: string; periodStart: Date } }
      update: { itinerariesCreated: { increment: number }; aiPromptsUsed: { increment: number } }
    }

    // Read-then-write here loses one of two concurrent generations.
    expect(call.update.itinerariesCreated).toEqual({ increment: 1 })
    expect(call.update.aiPromptsUsed).toEqual({ increment: 1 })
    expect(call.where.userId_periodStart.periodStart.toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })

  it('writes nothing when there is nothing to add', async () => {
    await recordUsage(USER_ID, {}, NOW)

    expect(mockDb.usageCounter.upsert).not.toHaveBeenCalled()
  })

  it('never records a negative delta', async () => {
    mockDb.usageCounter.upsert.mockResolvedValue({ id: 'counter-1' })

    await recordUsage(USER_ID, { itinerariesCreated: -5, aiPromptsUsed: 2 }, NOW)

    const call = mockDb.usageCounter.upsert.mock.lastCall?.[0] as {
      update: { itinerariesCreated: { increment: number } }
    }

    expect(call.update.itinerariesCreated).toEqual({ increment: 0 })
  })
})

describe('toPromptEntitlement', () => {
  it('reports an uncapped plan as the platform ceiling, not as "unlimited"', async () => {
    world({
      subscription: { id: 'sub-1', currentPeriodEnd: PERIOD_END, plan: PREMIUM_10 },
      counter: { itinerariesCreated: 3, aiPromptsUsed: 0 },
    })

    const entitlement = await resolveEntitlement(USER_ID, NOW)
    const context = toPromptEntitlement(entitlement, false)

    // A designer told "unlimited" happily drafts sixty days that no schema
    // will accept.
    expect(context.maxItineraryDays).toBe(MAX_TRIP_DAYS)
    expect(context.maxSavedItineraries).toBeNull()
    expect(context.generationsRemaining).toBe(7)
  })
})
