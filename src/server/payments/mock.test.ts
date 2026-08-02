import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetEnvCache } from '@/lib/env'
import { ApiError } from '@/server/http/errors'
import {
  MOCK_ENABLED_FLAG,
  MOCK_PRODUCTION_FLAG,
  assertMockPaymentsPermitted,
  mockPaymentsPermitted,
  mockProvider,
} from './mock'

/**
 * The refusal, from the outside.
 *
 * These are the most important tests in the payments module, and the only ones
 * whose failure is a business emergency rather than a bug. Everything else here
 * decides whether a feature works; this decides whether the paywall exists.
 *
 * The property under test is not "the flags are read". It is that the SAFE
 * answer is the one you get for doing nothing — an environment with no payment
 * configuration at all must refuse, in production and everywhere that is not a
 * developer's laptop. So most cases below set as little as possible and assert a
 * 403, which is the opposite of how one usually writes tests, and is the point.
 *
 * The database is mocked wholesale and then asserted to have been left alone.
 * "It refused" and "it refused BEFORE writing a Payment row" are different
 * claims, and only the second means a production deployment cannot be talked
 * into recording a payment it will not honour.
 */

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    payment: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
    itineraryUnlock: { create: vi.fn(), findUnique: vi.fn() },
    subscription: { create: vi.fn(), findUnique: vi.fn() },
    itinerary: { updateMany: vi.fn() },
    plan: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  },
}))

vi.mock('@/lib/db', () => ({ db: mockDb, disconnectDb: vi.fn() }))

/** The minimum any suite in this repo needs for `env()` to parse at all. */
function baseEnvironment(): void {
  process.env.DATABASE_URL =
    'postgresql://tester:not-a-real-password@localhost:5432/beyond_borders_test'
  process.env.AUTH_USER_SECRET = 'test-user-secret-0123456789-abcdefghij'
  process.env.AUTH_ADMIN_SECRET = 'test-admin-secret-0123456789-abcdefghij'
  process.env.PUBLIC_WEB_ORIGIN = 'http://localhost:3000'
}

/**
 * Write `NODE_ENV`, which Next's ambient types declare read-only.
 *
 * The cast is confined to this one function rather than sprinkled at each call
 * site. Read-only is the right default — application code has no business
 * rewriting it — but the whole subject of this suite is what happens under
 * NODE_ENV=production, and there is no way to test that without setting it.
 */
function setNodeEnv(value: 'development' | 'test' | 'production'): void {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}

/**
 * Put the process in a named environment with the payment flags as given.
 *
 * `undefined` DELETES the variable rather than setting it to the string
 * "undefined" — which matters more than it looks, since every case below that
 * proves a default is really asserting on the absence of a key.
 */
function environment(options: {
  nodeEnv: 'development' | 'test' | 'production'
  mockEnabled?: string | undefined
  allowInProduction?: string | undefined
}): void {
  baseEnvironment()

  setNodeEnv(options.nodeEnv)

  if (options.mockEnabled === undefined) delete process.env.PAYMENTS_MOCK_ENABLED
  else process.env.PAYMENTS_MOCK_ENABLED = options.mockEnabled

  if (options.allowInProduction === undefined) delete process.env.PAYMENTS_ALLOW_MOCK_IN_PRODUCTION
  else process.env.PAYMENTS_ALLOW_MOCK_IN_PRODUCTION = options.allowInProduction

  resetEnvCache()
}

/** Run something expected to refuse, and hand the refusal back for inspection. */
async function refusalFrom(action: () => unknown): Promise<ApiError> {
  try {
    await action()
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }

  throw new Error('Expected the sandbox gateway to refuse, but it did not.')
}

/** Both flag names in one assertion, because the message has to name both. */
function expectNamesBothFlags(error: ApiError): void {
  expect(error.status).toBe(403)
  expect(error.code).toBe('FORBIDDEN')
  expect(error.message).toContain(MOCK_ENABLED_FLAG)
  expect(error.message).toContain(MOCK_PRODUCTION_FLAG)
}

const PAYMENT_ID = '019373d4-4a1b-7c3e-9f00-2222bbbb0002'
const USER_ID = '019373d4-4a1b-7c3e-9f00-1111aaaa0001'
const PLAN_ID = '019373d4-4a1b-7c3e-9f00-7777aaaa0007'

function intent() {
  return {
    userId: USER_ID,
    purpose: 'SUBSCRIPTION' as const,
    amountBdt: 500,
    itineraryId: null,
    planId: PLAN_ID,
    bookingId: null,
    idempotencyKey: 'mock_test_key',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<unknown>) =>
    fn(mockDb)
  )
})

describe('production refuses by default', () => {
  it('refuses when NOTHING is configured — the case a careless deploy produces', () => {
    // No PAYMENTS_* variables at all. This is what a production environment
    // looks like when somebody deploys without thinking about payments, and it
    // is the likeliest way the sandbox would ever reach real users.
    environment({ nodeEnv: 'production' })

    expect(mockPaymentsPermitted()).toBe(false)
  })

  it('names both flags in the refusal', async () => {
    environment({ nodeEnv: 'production' })

    expectNamesBothFlags(await refusalFrom(() => assertMockPaymentsPermitted()))
  })

  it('still refuses when only PAYMENTS_MOCK_ENABLED is set — one flag is not enough', async () => {
    // The whole argument for two flags. Somebody copies a staging .env into
    // production, PAYMENTS_MOCK_ENABLED=true comes along for the ride, and the
    // second variable — which nobody copies, because nobody sets it — is what
    // stands between that mistake and free Premium for everyone.
    environment({ nodeEnv: 'production', mockEnabled: 'true' })

    const error = await refusalFrom(() => assertMockPaymentsPermitted())

    expectNamesBothFlags(error)
    expect(error.message).toContain('refuses to run in production')
  })

  it('refuses when the production flag is set but the sandbox is not enabled', async () => {
    // The mirror image, and it must also refuse: PAYMENTS_ALLOW_MOCK_IN_PRODUCTION
    // permits the sandbox in production, it does not switch the sandbox on.
    environment({ nodeEnv: 'production', allowInProduction: 'true' })

    expectNamesBothFlags(await refusalFrom(() => assertMockPaymentsPermitted()))
  })

  it('permits only when BOTH flags are true', () => {
    environment({ nodeEnv: 'production', mockEnabled: 'true', allowInProduction: 'true' })

    expect(mockPaymentsPermitted()).toBe(true)
  })

  it('reads "false" as false rather than as a non-empty string', () => {
    // `z.coerce.boolean()` would make this fail, because Boolean("false") is
    // true. `z.stringbool()` is used precisely so an operator who types false
    // gets false.
    environment({ nodeEnv: 'production', mockEnabled: 'true', allowInProduction: 'false' })

    expect(mockPaymentsPermitted()).toBe(false)
  })
})

describe('the default outside development', () => {
  it('is enabled in development with nothing set', () => {
    environment({ nodeEnv: 'development' })

    expect(mockPaymentsPermitted()).toBe(true)
  })

  it('is DISABLED under NODE_ENV=test with nothing set', () => {
    // Deliberate, and this suite depends on it: a test runner that silently
    // enabled the sandbox would make every refusal case above vacuous. Suites
    // exercising the happy path opt in explicitly.
    environment({ nodeEnv: 'test' })

    expect(mockPaymentsPermitted()).toBe(false)
  })

  it('can be switched off explicitly in development', async () => {
    environment({ nodeEnv: 'development', mockEnabled: 'false' })

    const error = await refusalFrom(() => assertMockPaymentsPermitted())

    expectNamesBothFlags(error)
    expect(error.message).toContain('switched off')
  })
})

describe('the refusal happens before anything is written', () => {
  it('does not create a Payment row when initiate is refused', async () => {
    environment({ nodeEnv: 'production' })

    expectNamesBothFlags(await refusalFrom(() => mockProvider.initiate(intent())))

    // The assertion that matters. "It threw" is not the same claim as "it threw
    // before writing", and only the second one means a production deployment
    // cannot be talked into recording a payment it will not honour.
    expect(mockDb.payment.create).not.toHaveBeenCalled()
  })

  it('does not touch the payment when settle is refused', async () => {
    environment({ nodeEnv: 'production' })

    expectNamesBothFlags(await refusalFrom(() => mockProvider.settle(PAYMENT_ID, 'SUCCESS')))

    expect(mockDb.$transaction).not.toHaveBeenCalled()
    expect(mockDb.payment.updateMany).not.toHaveBeenCalled()
    expect(mockDb.itineraryUnlock.create).not.toHaveBeenCalled()
    expect(mockDb.subscription.create).not.toHaveBeenCalled()
  })

  it('grants nothing when the sandbox is merely disabled, not in production', async () => {
    environment({ nodeEnv: 'development', mockEnabled: 'false' })

    await refusalFrom(() => mockProvider.settle(PAYMENT_ID, 'SUCCESS'))

    expect(mockDb.itineraryUnlock.create).not.toHaveBeenCalled()
    expect(mockDb.subscription.create).not.toHaveBeenCalled()
  })
})

describe('verify stays readable even when the sandbox is switched off', () => {
  it('reports the status of a payment created while it was on', async () => {
    // Documented behaviour rather than an oversight. `verify` grants nothing and
    // moves nothing; refusing to say what became of somebody's payment because a
    // flag changed afterwards would withhold information from its owner for no
    // safety benefit at all.
    environment({ nodeEnv: 'production' })
    mockDb.payment.findUnique.mockResolvedValue({ status: 'SUCCEEDED', provider: 'MOCK' })

    await expect(mockProvider.verify(PAYMENT_ID)).resolves.toBe('SUCCEEDED')
  })

  it('refuses to speak for a payment another provider created', async () => {
    environment({ nodeEnv: 'development', mockEnabled: 'true' })
    mockDb.payment.findUnique.mockResolvedValue({ status: 'SUCCEEDED', provider: 'BKASH' })

    const error = await refusalFrom(() => mockProvider.verify(PAYMENT_ID))

    expect(error.status).toBe(404)
  })
})
