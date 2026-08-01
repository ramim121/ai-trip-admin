import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetEnvCache } from '@/lib/env'
import { ApiError } from '@/server/http/errors'
import { clearSettingCache } from '@/server/settings/read'
import { CheckoutBody } from './schema'
import { completeMockPayment, openCheckout, readPayment } from './service'

/**
 * What a purchase costs, who may settle it, and what it grants.
 *
 * The database is a small in-memory fake rather than a pile of
 * `mockResolvedValue` calls, and that choice is the point of the file. Three of
 * the properties under test are only meaningful if the store REMEMBERS what
 * happened:
 *
 *   - a double submit grants once, which needs the first settlement to have
 *     changed the status the second one is tested against;
 *   - the conditional update is what enforces that, so the fake evaluates
 *     `updateMany`'s WHERE clause honestly and returns `{ count: 0 }` when it
 *     matches nothing;
 *   - the price comes from the settings row, so the row has to exist and be read.
 *
 * Stubbing each call to return a fixed value would let all three pass against an
 * implementation that grants twice.
 *
 * The unlock price in the fake is 350, not the seeded 200. A test asserting 200
 * would pass equally well against a hard-coded constant — which is exactly the
 * bug next door to the one the "never trust a client amount" rule prevents.
 */

const USER_ID = '019373d4-4a1b-7c3e-9f00-1111aaaa0001'
const OTHER_USER_ID = '019373d4-4a1b-7c3e-9f00-1111aaaa0002'
const ITINERARY_ID = '019373d4-4a1b-7c3e-9f00-6666ffff0006'

/** Deliberately not 200: proves the figure is read, not remembered. */
const CONFIGURED_UNLOCK_PRICE = 350
const PREMIUM_10_PRICE = 990

const PLANS = [
  {
    id: 'plan-premium-10',
    code: 'PREMIUM_10',
    name: 'Premium 10',
    priceBdt: PREMIUM_10_PRICE,
    interval: 'MONTHLY',
    isActive: true,
  },
  {
    id: 'plan-unlock-single',
    code: 'UNLOCK_SINGLE',
    name: 'Full itinerary unlock',
    priceBdt: 200,
    // The whole reason this plan is dangerous: a price with no billing period.
    interval: 'NONE',
    isActive: true,
  },
  {
    id: 'plan-retired',
    code: 'PREMIUM_50',
    name: 'Premium 50',
    priceBdt: 2900,
    interval: 'MONTHLY',
    isActive: false,
  },
]

interface PaymentRow {
  id: string
  userId: string | null
  provider: string
  purpose: string
  amountBdt: number
  status: string
  isTest: boolean
  itineraryId: string | null
  planId: string | null
  createdAt: Date
  settledAt: Date | null
}

interface UnlockRow {
  userId: string
  itineraryId: string
  paymentId: string | null
}

interface SubscriptionRow {
  userId: string
  planId: string
  paymentId: string | null
  status: string
  currentPeriodEnd: Date
}

const { store, mockDb } = vi.hoisted(() => {
  const store = {
    payments: [] as Record<string, unknown>[],
    unlocks: [] as Record<string, unknown>[],
    subscriptions: [] as Record<string, unknown>[],
    itineraries: [] as Record<string, unknown>[],
    plans: [] as Record<string, unknown>[],
    unlockPriceSetting: null as number | null,
    nextId: 1,
  }

  /** Does a row satisfy a flat Prisma `where`? Enough of one for these cases. */
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, condition]) => {
      if (condition !== null && typeof condition === 'object' && 'in' in condition) {
        return (condition.in as unknown[]).includes(row[key])
      }
      return row[key] === condition
    })

  const mockDb = {
    payment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const id = `payment-${store.nextId++}`
        const itinerary = store.itineraries.find((i) => i.id === data.itineraryId)
        const plan = store.plans.find((p) => p.id === data.planId)

        store.payments.push({
          ...data,
          id,
          providerRef: null,
          createdAt: new Date('2026-08-01T09:00:00.000Z'),
          settledAt: null,
          itinerary: itinerary ? { title: itinerary.title } : null,
          plan: plan ? { code: plan.code, name: plan.name } : null,
        })

        return { id }
      }),

      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          store.payments.find((row) => matches(row, where)) ?? null
      ),

      findUnique: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          store.payments.find((row) => row.id === where.id) ?? null
      ),

      /*
       * The honest implementation of the conditional update.
       *
       * Returning `{ count: 1 }` unconditionally — the obvious stub — would make
       * the idempotency test pass against an implementation that grants twice,
       * because the second call would also reach the grant. So the predicate is
       * evaluated for real, and a row already SUCCEEDED matches nothing.
       */
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>
          data: Record<string, unknown>
        }) => {
          const hits = store.payments.filter((row) => matches(row, where))
          for (const row of hits) Object.assign(row, data)
          return { count: hits.length }
        }
      ),

      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.payments.filter((row) => matches(row, where))
      ),

      count: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          store.payments.filter((row) => matches(row, where)).length
      ),
    },

    itineraryUnlock: {
      // Serves two different `where` shapes: the compound unique that
      // `isItineraryUnlocked` uses, and the `paymentId` `describeGrant` uses.
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const compound = where.userId_itineraryId as
          { userId: string; itineraryId: string } | undefined

        const row = compound
          ? store.unlocks.find(
              (u) => u.userId === compound.userId && u.itineraryId === compound.itineraryId
            )
          : store.unlocks.find((u) => u.paymentId === where.paymentId)

        if (row === undefined) return null

        const itinerary = store.itineraries.find((i) => i.id === row.itineraryId)
        return { ...row, itinerary: { title: itinerary?.title ?? 'Untitled' } }
      }),

      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        store.unlocks.push({ ...data })
        return data
      }),
    },

    subscription: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = store.subscriptions.find((s) => s.paymentId === where.paymentId)
        if (row === undefined) return null

        const plan = store.plans.find((p) => p.id === row.planId)
        return { ...row, plan: { code: plan?.code, name: plan?.name } }
      }),

      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        store.subscriptions.push({ ...data })
        return data
      }),

      findFirst: vi.fn(async () => null),
    },

    itinerary: {
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          store.itineraries.find((row) => matches(row, where)) ?? null
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => 0),
    },

    plan: {
      findUnique: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          store.plans.find((row) => matches(row, where)) ?? null
      ),
    },

    setting: {
      findUnique: vi.fn(async () =>
        store.unlockPriceSetting === null ? null : { value: store.unlockPriceSetting }
      ),
    },

    usageCounter: { findUnique: vi.fn(async () => null) },
    // The parameter is declared even though it is unused, so that
    // `mock.calls[0][0]` is typed as the audit payload rather than as `never` —
    // one case below reads the recorded rows back.
    auditLog: {
      create: vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: 'audit-1' })),
    },
    rateLimitBucket: {
      upsert: vi.fn(async () => ({ hits: 1 })),
      update: vi.fn(async () => ({ hits: 1 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },

    $transaction: vi.fn(),
  }

  return { store, mockDb }
})

vi.mock('@/lib/db', () => ({ db: mockDb, disconnectDb: vi.fn() }))

const CONTEXT = { ip: null, userAgent: null }

function unlocks(): UnlockRow[] {
  return store.unlocks as unknown as UnlockRow[]
}

function subscriptions(): SubscriptionRow[] {
  return store.subscriptions as unknown as SubscriptionRow[]
}

/** The stored row behind a checkout, by id. */
function storedPayment(paymentId: string): PaymentRow {
  const row = (store.payments as unknown as PaymentRow[]).find((p) => p.id === paymentId)
  if (row === undefined) throw new Error(`No payment ${paymentId} was stored.`)
  return row
}

/** Run something expected to be refused, and hand the refusal back. */
async function refusalFrom(action: () => unknown): Promise<ApiError> {
  try {
    await action()
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }

  throw new Error('Expected a refusal, but the call succeeded.')
}

/** The common case, written once: a sandbox checkout for the seeded itinerary. */
function unlockCheckout() {
  return openCheckout(USER_ID, { purpose: 'ITINERARY_UNLOCK', itineraryId: ITINERARY_ID }, CONTEXT)
}

beforeEach(() => {
  vi.clearAllMocks()

  store.payments.length = 0
  store.unlocks.length = 0
  store.subscriptions.length = 0
  store.itineraries.length = 0
  store.plans.length = 0
  store.nextId = 1

  store.plans.push(...PLANS)
  store.itineraries.push({ id: ITINERARY_ID, userId: USER_ID, title: 'Eight days in Bali' })
  store.unlockPriceSetting = CONFIGURED_UNLOCK_PRICE

  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) =>
    fn(mockDb)
  )

  process.env.DATABASE_URL =
    'postgresql://tester:not-a-real-password@localhost:5432/beyond_borders_test'
  process.env.AUTH_USER_SECRET = 'test-user-secret-0123456789-abcdefghij'
  process.env.AUTH_ADMIN_SECRET = 'test-admin-secret-0123456789-abcdefghij'
  process.env.PUBLIC_WEB_ORIGIN = 'http://localhost:3000'
  // Cast because Next's ambient types declare NODE_ENV read-only. See the same
  // note in mock.test.ts — the sandbox's behaviour is a function of this value,
  // so a suite that could not set it could not test it.
  ;(process.env as Record<string, string | undefined>).NODE_ENV = 'test'
  // Explicit, because the default under NODE_ENV=test is OFF. mock.test.ts
  // proves that; this suite needs the sandbox on to exercise anything at all.
  process.env.PAYMENTS_MOCK_ENABLED = 'true'
  delete process.env.PAYMENTS_ALLOW_MOCK_IN_PRODUCTION

  resetEnvCache()
  // `readCachedSetting` memoises for thirty seconds, longer than this suite
  // takes to run. Without this, one case's price leaks into the rest.
  clearSettingCache()
})

// ─────────────────────────────────────────────────────────────────────────────
// The price is the server's to decide
// ─────────────────────────────────────────────────────────────────────────────

describe('server-side amount resolution', () => {
  it('ignores an amount in the request body entirely', async () => {
    /*
     * The attack, written the way it would actually arrive: a well-formed body
     * with extra fields. They never reach the handler — `CheckoutBody` is a plain
     * object schema, so zod strips unknown keys during validation — and the
     * assertion below is that the row was priced from the settings row instead.
     */
    const parsed = CheckoutBody.parse({
      purpose: 'ITINERARY_UNLOCK',
      itineraryId: ITINERARY_ID,
      amountBdt: 1,
      priceBdt: 1,
      currency: 'BDT',
    })

    expect(parsed).not.toHaveProperty('amountBdt')

    const checkout = await openCheckout(USER_ID, parsed, CONTEXT)

    expect(checkout.amountBdt).toBe(CONFIGURED_UNLOCK_PRICE)
    expect(storedPayment(checkout.paymentId).amountBdt).toBe(CONFIGURED_UNLOCK_PRICE)
  })

  it('reads the unlock price from the settings row rather than a constant', async () => {
    // 350 is not the seeded default. A hard-coded 200 would fail here, which is
    // the only way to tell "reads the setting" from "happens to agree with it".
    const checkout = await unlockCheckout()

    expect(checkout.amountBdt).toBe(CONFIGURED_UNLOCK_PRICE)
    expect(checkout.amountBdt).not.toBe(200)
  })

  it('prices a subscription from the Plan row', async () => {
    const checkout = await openCheckout(
      USER_ID,
      { purpose: 'SUBSCRIPTION', planCode: 'PREMIUM_10' },
      CONTEXT
    )

    expect(checkout.amountBdt).toBe(PREMIUM_10_PRICE)
  })

  it('marks every sandbox payment as a test row', async () => {
    const checkout = await unlockCheckout()

    expect(checkout.isTest).toBe(true)
    expect(checkout.provider).toBe('MOCK')
    expect(storedPayment(checkout.paymentId).isTest).toBe(true)
  })

  it('sends the traveller to the public site, not to this API', async () => {
    const checkout = await unlockCheckout()

    expect(checkout.redirectUrl).toBe(`http://localhost:3000/checkout/${checkout.paymentId}`)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// UNLOCK_SINGLE is a price, not a tier
// ─────────────────────────────────────────────────────────────────────────────

describe('UNLOCK_SINGLE as a subscription', () => {
  it('is rejected at checkout', async () => {
    /*
     * The expensive mistake, refused at the first opportunity.
     *
     * UNLOCK_SINGLE carries `interval = NONE`. Were it allowed through, the
     * settlement would write a Subscription row, `resolveEntitlement` would rank
     * that plan by `sortOrder`, and one 200 BDT payment would become a permanent
     * account-wide grant.
     */
    const error = await refusalFrom(() =>
      openCheckout(USER_ID, { purpose: 'SUBSCRIPTION', planCode: 'UNLOCK_SINGLE' }, CONTEXT)
    )

    expect(error.status).toBe(400)
    expect(error.details?.[0]?.path).toBe('planCode')
    expect(error.message).toContain('one-off')
  })

  it('creates no payment row when it is rejected', async () => {
    await refusalFrom(() =>
      openCheckout(USER_ID, { purpose: 'SUBSCRIPTION', planCode: 'UNLOCK_SINGLE' }, CONTEXT)
    )

    expect(store.payments).toHaveLength(0)
  })

  it('also rejects FREE, for the same reason', async () => {
    // Not a special case for one plan code — the rule is about `interval`, so
    // any non-recurring row is refused the same way.
    store.plans.push({
      id: 'plan-free',
      code: 'FREE',
      name: 'Free',
      priceBdt: 0,
      interval: 'NONE',
      isActive: true,
    })

    const error = await refusalFrom(() =>
      openCheckout(USER_ID, { purpose: 'SUBSCRIPTION', planCode: 'FREE' }, CONTEXT)
    )

    expect(error.status).toBe(400)
  })

  it('refuses a plan that is no longer on sale', async () => {
    const error = await refusalFrom(() =>
      openCheckout(USER_ID, { purpose: 'SUBSCRIPTION', planCode: 'PREMIUM_50' }, CONTEXT)
    )

    expect(error.status).toBe(404)
  })

  it('never creates a Subscription when settling an itinerary unlock', async () => {
    // The CRITICAL rule, asserted on the outcome rather than on a refusal: even
    // a perfectly ordinary unlock purchase must leave the subscriptions table
    // untouched.
    const checkout = await unlockCheckout()

    await completeMockPayment(USER_ID, checkout.paymentId, 'SUCCESS', CONTEXT)

    expect(unlocks()).toHaveLength(1)
    expect(subscriptions()).toHaveLength(0)
    expect(mockDb.subscription.create).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Settling once, however many times it is asked for
// ─────────────────────────────────────────────────────────────────────────────

describe('idempotent settlement', () => {
  it('grants exactly once when the completion is submitted twice', async () => {
    const checkout = await unlockCheckout()

    const first = await completeMockPayment(USER_ID, checkout.paymentId, 'SUCCESS', CONTEXT)
    const second = await completeMockPayment(USER_ID, checkout.paymentId, 'SUCCESS', CONTEXT)

    // One grant, not two. The conditional update matched no row the second time.
    expect(unlocks()).toHaveLength(1)
    expect(mockDb.itineraryUnlock.create).toHaveBeenCalledTimes(1)

    // And the two responses are indistinguishable, which is what makes the
    // endpoint safe for a client to retry blindly.
    expect(second.payment.status).toBe('SUCCEEDED')
    expect(second.grant).toEqual(first.grant)
  })

  it('predicates the status flip on the current status', async () => {
    const checkout = await unlockCheckout()

    await completeMockPayment(USER_ID, checkout.paymentId, 'SUCCESS', CONTEXT)

    /*
     * Asserted on the SHAPE of the statement, not only on its effect.
     *
     * The difference between a cap and a suggestion is whether the ceiling sits
     * in the WHERE clause or in a JavaScript comparison beforehand. A refactor
     * that read the status, compared it, then updated by id alone would still
     * pass the test above under this single-threaded fake — and would grant twice
     * under real concurrency. This is what stops that landing.
     */
    const call = mockDb.payment.updateMany.mock.calls[0]
    const where = (call?.[0] as { where: Record<string, unknown> }).where

    expect(where.id).toBe(checkout.paymentId)
    expect(where.status).toEqual({ in: ['INITIATED', 'PENDING'] })
  })

  it('does not re-settle when the outcome changes on the replay', async () => {
    // A confused or malicious client settling SUCCESS then FAILURE must not undo
    // anything: the payment is terminal after the first call.
    const checkout = await unlockCheckout()

    await completeMockPayment(USER_ID, checkout.paymentId, 'SUCCESS', CONTEXT)
    const replay = await completeMockPayment(USER_ID, checkout.paymentId, 'FAILURE', CONTEXT)

    expect(replay.payment.status).toBe('SUCCEEDED')
    expect(unlocks()).toHaveLength(1)
  })

  it('audits the replay as such', async () => {
    const checkout = await unlockCheckout()

    await completeMockPayment(USER_ID, checkout.paymentId, 'SUCCESS', CONTEXT)
    await completeMockPayment(USER_ID, checkout.paymentId, 'SUCCESS', CONTEXT)

    const settlements = mockDb.auditLog.create.mock.calls
      .map(([args]) => args.data)
      .filter((data) => data.action === 'payment.mock_settled')

    expect(settlements).toHaveLength(2)
    expect((settlements[0]?.after as { alreadySettled: boolean }).alreadySettled).toBe(false)
    expect((settlements[1]?.after as { alreadySettled: boolean }).alreadySettled).toBe(true)
  })

  it('grants nothing on a declined payment', async () => {
    const checkout = await unlockCheckout()

    const result = await completeMockPayment(USER_ID, checkout.paymentId, 'FAILURE', CONTEXT)

    expect(result.payment.status).toBe('FAILED')
    expect(result.grant).toBeNull()
    expect(unlocks()).toHaveLength(0)
  })

  it('grants nothing on a cancelled payment', async () => {
    const checkout = await unlockCheckout()

    const result = await completeMockPayment(USER_ID, checkout.paymentId, 'CANCEL', CONTEXT)

    expect(result.payment.status).toBe('FAILED')
    expect(unlocks()).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Whose payment is it
// ─────────────────────────────────────────────────────────────────────────────

describe('ownership enforcement', () => {
  it("refuses to settle another traveller's payment, and grants nothing", async () => {
    const checkout = await unlockCheckout()

    const error = await refusalFrom(() =>
      completeMockPayment(OTHER_USER_ID, checkout.paymentId, 'SUCCESS', CONTEXT)
    )

    // 404, not 403: a 403 would confirm that a guessed payment id names a real
    // payment, which is the reasoning the itinerary routes already follow.
    expect(error.status).toBe(404)
    expect(unlocks()).toHaveLength(0)
    expect(storedPayment(checkout.paymentId).status).toBe('INITIATED')
  })

  it('lets the real owner settle the same payment afterwards', async () => {
    const checkout = await unlockCheckout()

    await refusalFrom(() =>
      completeMockPayment(OTHER_USER_ID, checkout.paymentId, 'SUCCESS', CONTEXT)
    )

    const result = await completeMockPayment(USER_ID, checkout.paymentId, 'SUCCESS', CONTEXT)

    expect(result.payment.status).toBe('SUCCEEDED')
    expect(unlocks()).toHaveLength(1)
  })

  it("refuses to read another traveller's payment", async () => {
    const checkout = await unlockCheckout()

    const error = await refusalFrom(() => readPayment(OTHER_USER_ID, checkout.paymentId))

    expect(error.status).toBe(404)
  })

  it('will not settle a payment a real gateway created', async () => {
    /*
     * The hole this closes: open a genuine bKash checkout, never pay, then POST
     * to the sandbox completion route. The provider is part of the lookup, so
     * the payment is simply not found — a 404, indistinguishable from one that
     * belongs to somebody else.
     */
    const checkout = await unlockCheckout()
    storedPayment(checkout.paymentId).provider = 'BKASH'

    const error = await refusalFrom(() =>
      completeMockPayment(USER_ID, checkout.paymentId, 'SUCCESS', CONTEXT)
    )

    expect(error.status).toBe(404)
    expect(unlocks()).toHaveLength(0)
  })

  it('refuses a checkout against an itinerary the caller does not own', async () => {
    const error = await refusalFrom(() =>
      openCheckout(
        OTHER_USER_ID,
        { purpose: 'ITINERARY_UNLOCK', itineraryId: ITINERARY_ID },
        CONTEXT
      )
    )

    expect(error.status).toBe(404)
    expect(store.payments).toHaveLength(0)
  })

  it('refuses to sell the same itinerary twice', async () => {
    store.unlocks.push({ userId: USER_ID, itineraryId: ITINERARY_ID, paymentId: 'payment-earlier' })

    const error = await refusalFrom(() => unlockCheckout())

    expect(error.status).toBe(409)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// What a subscription settlement actually writes
// ─────────────────────────────────────────────────────────────────────────────

describe('subscription settlement', () => {
  it('activates the plan for one month', async () => {
    const checkout = await openCheckout(
      USER_ID,
      { purpose: 'SUBSCRIPTION', planCode: 'PREMIUM_10' },
      CONTEXT
    )

    const result = await completeMockPayment(USER_ID, checkout.paymentId, 'SUCCESS', CONTEXT)

    expect(subscriptions()).toHaveLength(1)

    const subscription = subscriptions()[0]!
    expect(subscription.status).toBe('ACTIVE')
    expect(subscription.planId).toBe('plan-premium-10')
    expect(subscription.paymentId).toBe(checkout.paymentId)

    // One month, by the same clamping arithmetic the metering window uses.
    const ahead = subscription.currentPeriodEnd.getTime() - Date.now()
    expect(ahead).toBeGreaterThan(27 * 24 * 60 * 60 * 1_000)
    expect(ahead).toBeLessThan(32 * 24 * 60 * 60 * 1_000)

    expect(result.grant?.kind).toBe('SUBSCRIPTION')
    expect(result.grant?.planCode).toBe('PREMIUM_10')
    expect(result.grant?.activeUntil).not.toBeNull()
  })

  it('creates no ItineraryUnlock', async () => {
    const checkout = await openCheckout(
      USER_ID,
      { purpose: 'SUBSCRIPTION', planCode: 'PREMIUM_10' },
      CONTEXT
    )

    await completeMockPayment(USER_ID, checkout.paymentId, 'SUCCESS', CONTEXT)

    expect(unlocks()).toHaveLength(0)
  })
})
