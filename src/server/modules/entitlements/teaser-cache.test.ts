import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetEnvCache } from '@/lib/env'
import type { TeaserQuestionnaire, TeaserResponse } from '@/server/ai/schemas'
import { readTeaserCache, teaserCacheHash, writeTeaserCache } from './teaser-cache'

/**
 * The teaser cache.
 *
 * Worth testing carefully despite being small, because it is an abuse control
 * wearing the clothes of a performance optimisation. If two spellings of the
 * same trip produce two keys, retyping the destination buys a second model
 * call, and the one-prompt limit is the only thing left holding the line.
 */

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    teaserCache: { update: vi.fn(), upsert: vi.fn() },
  },
}))

vi.mock('@/lib/db', () => ({ db: mockDb, disconnectDb: vi.fn() }))

process.env.DATABASE_URL =
  'postgresql://tester:not-a-real-password@localhost:5432/beyond_borders_test'
process.env.AUTH_USER_SECRET = 'test-user-secret-0123456789-abcdefghij'
process.env.AUTH_ADMIN_SECRET = 'test-admin-secret-0123456789-abcdefghij'
resetEnvCache()

const ANSWERS: TeaserQuestionnaire = {
  destination: "Cox's Bazar",
  totalDays: 4,
  partySize: 2,
  purpose: 'HONEYMOON',
}

const PAYLOAD: TeaserResponse = {
  headline: 'Four slow days on the bay',
  overview: 'You would be out on the water before the heat arrives, and back before the crowds.',
  dayHighlights: [
    {
      dayNumber: 1,
      headline: 'Arrive and walk the shoreline',
      summary: 'A long, flat beach that takes the edge off a travel day.',
    },
  ],
  suggestedInterests: ['snorkelling', 'seafood'],
  callToAction: 'Sign in and we will build the whole thing, day by day.',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('teaserCacheHash', () => {
  it('is a sha256 digest', () => {
    expect(teaserCacheHash(ANSWERS)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('collapses spelling variants of the same trip onto one entry', () => {
    const key = teaserCacheHash(ANSWERS)

    // Retyping the destination in a fresh incognito window must not buy a
    // second model call.
    expect(teaserCacheHash({ ...ANSWERS, destination: "  cox's   BAZAR " })).toBe(key)
    expect(teaserCacheHash({ ...ANSWERS, destination: "COX'S BAZAR" })).toBe(key)

    // The three spellings the comment at the top of this module has always
    // claimed were one entry. Until the key normalised punctuation they were
    // three, so dropping an apostrophe bought an uncached, unauthenticated
    // model call.
    expect(teaserCacheHash({ ...ANSWERS, destination: 'coxs  bazar ' })).toBe(key)
    // U+2019, which is what a phone keyboard produces without being asked.
    expect(teaserCacheHash({ ...ANSWERS, destination: 'Cox’s Bazar' })).toBe(key)
  })

  it('does not sell a second model call for a punctuation mark', () => {
    const bangkok = { ...ANSWERS, destination: 'bangkok' }
    const key = teaserCacheHash(bangkok)

    // Every one of these used to be its own cache entry, which made permuting
    // punctuation an unlimited supply of uncached generations. The cache is the
    // only thing making a bypass attempt cost nothing, so a key that separates
    // spellings of one question is an abuse control that does not work.
    expect(teaserCacheHash({ ...bangkok, destination: 'Bangkok.' })).toBe(key)
    expect(teaserCacheHash({ ...bangkok, destination: 'bangkok!' })).toBe(key)
    expect(teaserCacheHash({ ...bangkok, destination: '  bangkok  ' })).toBe(key)
    // NFKD splits "ä" into "a" plus a combining mark, and the mark is dropped.
    expect(teaserCacheHash({ ...bangkok, destination: 'bängkok' })).toBe(key)

    // A U+00A0 no-break space folds like any other whitespace, so both
    // spellings of "bang kok" are one question. Written as an escape rather
    // than a raw character because the difference is invisible in a diff, and
    // somebody would eventually "tidy" it back into a plain space.
    expect(teaserCacheHash({ ...bangkok, destination: 'bang\u00A0kok' })).toBe(
      teaserCacheHash({ ...bangkok, destination: 'bang kok' })
    )
  })

  it('separates trips that differ in any one answer', () => {
    const key = teaserCacheHash(ANSWERS)

    expect(teaserCacheHash({ ...ANSWERS, totalDays: 5 })).not.toBe(key)
    expect(teaserCacheHash({ ...ANSWERS, partySize: 3 })).not.toBe(key)
    expect(teaserCacheHash({ ...ANSWERS, purpose: 'FAMILY' })).not.toBe(key)
    expect(teaserCacheHash({ ...ANSWERS, destination: 'Sylhet' })).not.toBe(key)
  })
})

describe('readTeaserCache', () => {
  it('counts the hit in the same statement as the read', async () => {
    mockDb.teaserCache.update.mockResolvedValue({ payload: PAYLOAD })

    const cached = await readTeaserCache(ANSWERS)

    expect(cached).toEqual(PAYLOAD)

    const call = mockDb.teaserCache.update.mock.lastCall?.[0] as {
      where: { cacheKey: string }
      data: { hitCount: { increment: number }; lastHitAt: Date }
    }

    // A select followed by a write loses counts under exactly the traffic that
    // makes this cache worth having.
    expect(call.where.cacheKey).toBe(teaserCacheHash(ANSWERS))
    expect(call.data.hitCount).toEqual({ increment: 1 })
    expect(call.data.lastHitAt).toBeInstanceOf(Date)
  })

  it('reports a miss when there is no entry', async () => {
    const { Prisma } = await import('@/generated/prisma/client')
    mockDb.teaserCache.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('not found', {
        code: 'P2025',
        clientVersion: 'test',
      })
    )

    await expect(readTeaserCache(ANSWERS)).resolves.toBeNull()
  })

  it('treats an unparseable payload as a miss rather than serving it', async () => {
    // The column is Json, so it holds whatever an older deploy wrote — or
    // whatever somebody typed into a database console.
    mockDb.teaserCache.update.mockResolvedValue({ payload: { headline: 'truncated' } })

    await expect(readTeaserCache(ANSWERS)).resolves.toBeNull()
  })

  it('does not swallow a real database failure', async () => {
    mockDb.teaserCache.update.mockRejectedValue(new Error('connection terminated'))

    await expect(readTeaserCache(ANSWERS)).rejects.toThrow('connection terminated')
  })
})

describe('writeTeaserCache', () => {
  it('upserts on the key, so a simultaneous miss is not a conflict', async () => {
    mockDb.teaserCache.upsert.mockResolvedValue({ id: 'cache-1' })

    await writeTeaserCache(ANSWERS, PAYLOAD)

    const call = mockDb.teaserCache.upsert.mock.lastCall?.[0] as {
      where: { cacheKey: string }
      create: { cacheKey: string; payload: unknown }
      update: Record<string, unknown>
    }

    expect(call.where.cacheKey).toBe(teaserCacheHash(ANSWERS))
    expect(call.create.payload).toEqual(PAYLOAD)
    // Replacing a payload does not un-happen the hits it already served.
    expect(call.update).not.toHaveProperty('hitCount')
  })
})
