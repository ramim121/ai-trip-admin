import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetEnvCache } from '@/lib/env'
import { ApiError } from './errors'
import { consumeRateLimit, enforceRateLimit, pruneRateLimitBuckets } from './rate-limit'

/**
 * The fixed-window limiter.
 *
 * The database is mocked, but the mock behaves the way Postgres behaves — the
 * upsert yields and then applies its increment in one synchronous step, which
 * is what a row lock buys. That matters, because the property being asserted is
 * concurrency: a limiter that only holds when requests arrive one at a time is
 * not a limiter, it is an honour system.
 */

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    rateLimitBucket: { upsert: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  },
}))

vi.mock('@/lib/db', () => ({ db: mockDb, disconnectDb: vi.fn() }))

process.env.DATABASE_URL =
  'postgresql://tester:not-a-real-password@localhost:5432/beyond_borders_test'
process.env.AUTH_USER_SECRET = 'test-user-secret-0123456789-abcdefghij'
process.env.AUTH_ADMIN_SECRET = 'test-admin-secret-0123456789-abcdefghij'
resetEnvCache()

const RULE = { key: 'teaser:ip:test-digest', limit: 3, windowSeconds: 60 }

/**
 * A table that behaves the way Postgres behaves.
 *
 * The upsert yields to the event loop first, so every concurrent caller has
 * started before any of them applies, and then increments synchronously. That
 * is exactly the guarantee `INSERT … ON CONFLICT DO UPDATE` gives against the
 * unique index: whoever arrives second reads the committed value, not the one
 * they saw on the way in.
 */
function tableUnderLock() {
  const rows = new Map<string, number>()

  const upsert = vi.fn(
    async ({
      where,
    }: {
      where: { bucketKey_windowStart: { bucketKey: string; windowStart: Date } }
    }) => {
      await new Promise((resolve) => setImmediate(resolve))

      const { bucketKey, windowStart } = where.bucketKey_windowStart
      const id = `${bucketKey}@${windowStart.toISOString()}`
      const hits = (rows.get(id) ?? 0) + 1
      rows.set(id, hits)

      return { hits }
    }
  )

  return { rows, upsert }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.rateLimitBucket.deleteMany.mockResolvedValue({ count: 0 })
})

describe('consumeRateLimit', () => {
  it('counts this hit before answering, and allows up to the limit', async () => {
    const table = tableUnderLock()
    mockDb.rateLimitBucket.upsert.mockImplementation(table.upsert)

    const verdicts = []
    for (let i = 0; i < 4; i += 1) verdicts.push(await consumeRateLimit(RULE))

    // Three allowed, the fourth refused — the hit is recorded first, so the
    // verdict is about a count that already includes the caller asking.
    expect(verdicts.map((v) => v.allowed)).toEqual([true, true, true, false])
    expect(verdicts.map((v) => v.hits)).toEqual([1, 2, 3, 4])
  })

  it('lets exactly `limit` of many simultaneous callers through', async () => {
    const table = tableUnderLock()
    mockDb.rateLimitBucket.upsert.mockImplementation(table.upsert)

    const verdicts = await Promise.all(Array.from({ length: 10 }, () => consumeRateLimit(RULE)))

    // Ten requests fired at once is the entire attack, and it costs nothing to
    // run. Incrementing after the check instead of before would pass all ten.
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(RULE.limit)
  })

  it('would catch a check-then-increment implementation', async () => {
    // The control experiment. Without it the test above proves only that this
    // harness cannot observe the race, so here is the naive version that
    // `consumeRateLimit` deliberately is not.
    let hits = 0

    const naive = async (limit: number): Promise<boolean> => {
      const seen = await Promise.resolve(hits)
      await new Promise((resolve) => setImmediate(resolve))
      if (seen >= limit) return false
      hits = seen + 1
      return true
    }

    const results = await Promise.all(Array.from({ length: 10 }, () => naive(RULE.limit)))

    expect(results.filter(Boolean).length).toBeGreaterThan(RULE.limit)
  })

  it('keeps counting refused hits, so hammering does not shorten the window', async () => {
    const table = tableUnderLock()
    mockDb.rateLimitBucket.upsert.mockImplementation(table.upsert)

    for (let i = 0; i < 10; i += 1) await consumeRateLimit(RULE)

    expect([...table.rows.values()]).toEqual([10])
  })

  it('floors the window start, so callers share absolute boundaries', async () => {
    mockDb.rateLimitBucket.upsert.mockResolvedValue({ hits: 2 })

    await consumeRateLimit(RULE, new Date('2026-08-01T09:00:41.512Z'))
    await consumeRateLimit(RULE, new Date('2026-08-01T09:00:59.999Z'))

    const windows = mockDb.rateLimitBucket.upsert.mock.calls.map(
      (call) =>
        (call[0] as { where: { bucketKey_windowStart: { windowStart: Date } } }).where
          .bucketKey_windowStart.windowStart
    )

    // Both land in the 09:00:00 minute. A window that started when the caller
    // first appeared would let anybody reset their own allowance by pausing.
    expect(windows[0]?.toISOString()).toBe('2026-08-01T09:00:00.000Z')
    expect(windows[1]?.toISOString()).toBe('2026-08-01T09:00:00.000Z')
  })

  it('opens a fresh window once the old one has rolled over', async () => {
    const table = tableUnderLock()
    mockDb.rateLimitBucket.upsert.mockImplementation(table.upsert)

    const spent = await consumeRateLimit(RULE, new Date('2026-08-01T09:00:30.000Z'))
    const next = await consumeRateLimit(RULE, new Date('2026-08-01T09:01:00.000Z'))

    expect(spent.hits).toBe(1)
    expect(next.hits).toBe(1)
    expect(table.rows.size).toBe(2)
  })

  it('reports how long the caller has to wait', async () => {
    mockDb.rateLimitBucket.upsert.mockResolvedValue({ hits: 9 })

    const verdict = await consumeRateLimit(RULE, new Date('2026-08-01T09:00:20.000Z'))

    expect(verdict.allowed).toBe(false)
    expect(verdict.retryAfterSeconds).toBe(40)
  })

  it('separates keys, so one surface cannot spend another surface’s allowance', async () => {
    const table = tableUnderLock()
    mockDb.rateLimitBucket.upsert.mockImplementation(table.upsert)

    await consumeRateLimit(RULE)
    await consumeRateLimit({ ...RULE, key: 'teaser:ip:someone-else' })

    expect([...table.rows.values()]).toEqual([1, 1])
  })

  it('retries as a plain increment when two new windows race to insert', async () => {
    const { Prisma } = await import('@/generated/prisma/client')
    const conflict = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    })

    mockDb.rateLimitBucket.upsert.mockRejectedValue(conflict)
    mockDb.rateLimitBucket.update.mockResolvedValue({ hits: 2 })

    const verdict = await consumeRateLimit(RULE)

    // The loser of the insert race must land on the winner's row: not fail the
    // request, and not start a second count that would double the allowance.
    expect(verdict.hits).toBe(2)
    expect(mockDb.rateLimitBucket.update.mock.lastCall?.[0]).toMatchObject({
      data: { hits: { increment: 1 } },
    })
  })

  it('does not swallow a real database failure into an allow', async () => {
    mockDb.rateLimitBucket.upsert.mockRejectedValue(new Error('connection terminated'))

    // Failing open would make "make the database unhappy" the cheapest way to
    // switch the limiter off.
    await expect(consumeRateLimit(RULE)).rejects.toThrow('connection terminated')
  })

  it('sweeps closed windows when it opens a new one, and not otherwise', async () => {
    const table = tableUnderLock()
    mockDb.rateLimitBucket.upsert.mockImplementation(table.upsert)

    await consumeRateLimit(RULE, new Date('2026-08-01T09:00:00.000Z'))
    expect(mockDb.rateLimitBucket.deleteMany).toHaveBeenCalledTimes(1)

    const swept = mockDb.rateLimitBucket.deleteMany.mock.lastCall?.[0] as {
      where: { windowStart: { lt: Date } }
    }
    // Two days back — comfortably beyond the longest window in use, so a
    // bucket is never deleted while it is still counting.
    expect(swept.where.windowStart.lt.toISOString()).toBe('2026-07-30T09:00:00.000Z')

    await consumeRateLimit(RULE, new Date('2026-08-01T09:00:10.000Z'))
    // Second hit in the same window: nothing new opened, so nothing to sweep.
    expect(mockDb.rateLimitBucket.deleteMany).toHaveBeenCalledTimes(1)
  })
})

describe('enforceRateLimit', () => {
  it('says nothing when the caller is inside the limit', async () => {
    mockDb.rateLimitBucket.upsert.mockResolvedValue({ hits: 1 })

    await expect(enforceRateLimit(RULE, 'slow down')).resolves.toBeUndefined()
  })

  it('throws 429 RATE_LIMITED carrying the caller’s own message', async () => {
    mockDb.rateLimitBucket.upsert.mockResolvedValue({ hits: 99 })

    // The message belongs to the caller because "you are asking too fast" and
    // "the site has generated every preview it will today" are different facts.
    await expect(enforceRateLimit(RULE, 'slow down')).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'slow down',
    })
    await expect(enforceRateLimit(RULE, 'slow down')).rejects.toBeInstanceOf(ApiError)
  })
})

describe('pruneRateLimitBuckets', () => {
  it('deletes by window start and nothing else', async () => {
    mockDb.rateLimitBucket.deleteMany.mockResolvedValue({ count: 7 })
    const cutoff = new Date('2026-07-30T00:00:00.000Z')

    await expect(pruneRateLimitBuckets(cutoff)).resolves.toBe(7)
    expect(mockDb.rateLimitBucket.deleteMany.mock.lastCall?.[0]).toEqual({
      where: { windowStart: { lt: cutoff } },
    })
  })
})
