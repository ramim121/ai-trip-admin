import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetEnvCache } from '@/lib/env'
import { hashFingerprint, hashIp } from '@/server/auth/crypto'
import { clearSettingCache } from '@/server/settings/read'
import {
  ANONYMOUS_PROMPT_LIMIT,
  consumePrompt,
  convertVisitor,
  identifyVisitor,
  mintVisitorCookieId,
  readVisitorCookie,
  refundPrompt,
  signVisitorCookie,
} from './anonymous'

/**
 * Visitor identification and the one-prompt quota.
 *
 * The database is mocked; the crypto is not. Asserting that a cookie really
 * survives its own signature check, and that a tampered one really does not, is
 * most of the point of having a signature.
 *
 * The section that matters most is the concurrency guard, tested three ways:
 * the shape of the query, the behaviour under simultaneous callers, and a
 * control experiment proving the harness can actually catch the race it claims
 * to rule out.
 */

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    anonymousVisitor: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    setting: { findUnique: vi.fn() },
  },
}))

vi.mock('@/lib/db', () => ({ db: mockDb, disconnectDb: vi.fn() }))

process.env.DATABASE_URL =
  'postgresql://tester:not-a-real-password@localhost:5432/beyond_borders_test'
process.env.AUTH_USER_SECRET = 'test-user-secret-0123456789-abcdefghij'
process.env.AUTH_ADMIN_SECRET = 'test-admin-secret-0123456789-abcdefghij'
resetEnvCache()

const VISITOR_ID = '019373d4-4a1b-7c3e-9f00-7777aaaa0007'
const USER_ID = '019373d4-4a1b-7c3e-9f00-1111aaaa0001'
const COOKIE_ID = '019373d4-4a1b-7c3e-9f00-8888bbbb0008'

/** RFC 5737 documentation range — never a real address. */
const IP = '203.0.113.7'
const FINGERPRINT = 'fp-9c1e77a2'

const EXISTING = {
  id: VISITOR_ID,
  cookieId: COOKIE_ID,
  promptsUsed: 0,
  convertedUserId: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  clearSettingCache()
  mockDb.setting.findUnique.mockResolvedValue(null)
  mockDb.anonymousVisitor.update.mockResolvedValue({ id: VISITOR_ID })
})

describe('the visitor cookie', () => {
  it('round-trips an id it signed', () => {
    const id = mintVisitorCookieId()

    expect(readVisitorCookie(signVisitorCookie(id))).toBe(id)
  })

  it('rejects an id somebody chose for themselves', () => {
    // Without the signature, typing a fresh uuid into devtools would be an
    // unlimited supply of first visits.
    expect(readVisitorCookie(COOKIE_ID)).toBeNull()
  })

  it('rejects a tampered signature', () => {
    const signed = signVisitorCookie(COOKIE_ID)
    const tampered = `${signed.slice(0, -1)}${signed.endsWith('A') ? 'B' : 'A'}`

    expect(readVisitorCookie(tampered)).toBeNull()
  })

  it('rejects an id swapped in under a valid signature', () => {
    const signed = signVisitorCookie(COOKIE_ID)
    const signature = signed.slice(signed.lastIndexOf('.') + 1)
    const other = mintVisitorCookieId()

    expect(readVisitorCookie(`${other}.${signature}`)).toBeNull()
  })

  it('rejects absent, oversized and malformed values without throwing', () => {
    expect(readVisitorCookie(null)).toBeNull()
    expect(readVisitorCookie(undefined)).toBeNull()
    expect(readVisitorCookie('')).toBeNull()
    expect(readVisitorCookie('no-separator-here')).toBeNull()
    expect(readVisitorCookie(`${COOKIE_ID}.`)).toBeNull()
    expect(readVisitorCookie('x'.repeat(5_000))).toBeNull()
  })
})

describe('identifyVisitor', () => {
  it('matches on any single signal, not on all three', async () => {
    mockDb.anonymousVisitor.findFirst.mockResolvedValue(EXISTING)

    await identifyVisitor({ cookieId: COOKIE_ID, ip: IP, fingerprint: FINGERPRINT })

    const query = mockDb.anonymousVisitor.findFirst.mock.lastCall?.[0] as {
      where: { OR: Record<string, string>[] }
    }

    expect(query.where.OR).toEqual([
      { cookieId: COOKIE_ID },
      { ipHash: hashIp(IP) },
      { fingerprintHash: hashFingerprint(FINGERPRINT) },
    ])
  })

  it('recognises somebody who cleared their cookies but kept their IP', async () => {
    mockDb.anonymousVisitor.findFirst.mockResolvedValue({ ...EXISTING, promptsUsed: 1 })

    const visitor = await identifyVisitor({ cookieId: null, ip: IP, fingerprint: null })

    expect(visitor?.created).toBe(false)
    expect(visitor?.promptsUsed).toBe(1)
    // The canonical cookie comes back, pulling the browser onto the identity it
    // tried to shed.
    expect(visitor?.cookieId).toBe(COOKIE_ID)
    expect(mockDb.anonymousVisitor.create).not.toHaveBeenCalled()
  })

  it('leaves absent signals out of the query rather than matching them against null', async () => {
    mockDb.anonymousVisitor.findFirst.mockResolvedValue(EXISTING)

    await identifyVisitor({ cookieId: null, ip: IP, fingerprint: null })

    const query = mockDb.anonymousVisitor.findFirst.mock.lastCall?.[0] as {
      where: { OR: Record<string, string>[] }
    }

    // "No fingerprint" must not find every other visitor who also sent none.
    expect(query.where.OR).toEqual([{ ipHash: hashIp(IP) }])
  })

  it('prefers the identity that has already spent a prompt', async () => {
    mockDb.anonymousVisitor.findFirst.mockResolvedValue(EXISTING)

    await identifyVisitor({ cookieId: COOKIE_ID, ip: IP, fingerprint: FINGERPRINT })

    const query = mockDb.anonymousVisitor.findFirst.mock.lastCall?.[0] as {
      orderBy: Record<string, string>[]
    }

    // Reverse this and an incognito window becomes a working bypass whenever it
    // manages to create the second row first.
    expect(query.orderBy).toEqual([{ promptsUsed: 'desc' }, { firstSeenAt: 'asc' }])
  })

  it('stores digests, never the raw address or fingerprint', async () => {
    mockDb.anonymousVisitor.findFirst.mockResolvedValue(null)
    mockDb.anonymousVisitor.create.mockResolvedValue(EXISTING)

    await identifyVisitor({ cookieId: COOKIE_ID, ip: IP, fingerprint: FINGERPRINT })

    const created = mockDb.anonymousVisitor.create.mock.lastCall?.[0] as {
      data: { ipHash: string; fingerprintHash: string }
    }

    expect(created.data.ipHash).toBe(hashIp(IP))
    expect(created.data.fingerprintHash).toBe(hashFingerprint(FINGERPRINT))
    // This table must never become a location log for the people it meters.
    expect(JSON.stringify(created.data)).not.toContain(IP)
    expect(JSON.stringify(created.data)).not.toContain(FINGERPRINT)
  })

  it('gives an absent signal a value that matches nothing but itself', async () => {
    mockDb.anonymousVisitor.findFirst.mockResolvedValue(null)
    mockDb.anonymousVisitor.create.mockResolvedValue(EXISTING)

    await identifyVisitor({ cookieId: COOKIE_ID, ip: null, fingerprint: null })
    const first = mockDb.anonymousVisitor.create.mock.lastCall?.[0] as {
      data: { ipHash: string; fingerprintHash: string }
    }

    await identifyVisitor({ cookieId: COOKIE_ID, ip: null, fingerprint: null })
    const second = mockDb.anonymousVisitor.create.mock.lastCall?.[0] as {
      data: { ipHash: string; fingerprintHash: string }
    }

    // A shared placeholder would fuse every visitor with no fingerprint into
    // one, so the first scripted request would exhaust the quota for all of
    // them.
    expect(first.data.ipHash).not.toBe(second.data.ipHash)
    expect(first.data.fingerprintHash).not.toBe(second.data.fingerprintHash)
  })

  it('reports a caller with no signal at all as unidentifiable, and creates nothing', async () => {
    mockDb.anonymousVisitor.create.mockResolvedValue(EXISTING)

    const visitor = await identifyVisitor({ cookieId: null, ip: null, fingerprint: null })

    // This used to mint a row with promptsUsed 0 and hand it back as a
    // brand-new visitor, which is a free preview for every request that simply
    // declined to identify itself — no cookie, no fingerprint, and no resolved
    // address. A plain curl loop against an edge-less deployment produced
    // exactly this, once per request, for as long as anyone cared to run it.
    expect(visitor).toBeNull()
    expect(mockDb.anonymousVisitor.create).not.toHaveBeenCalled()
    // Nothing to match on, so there is nothing to ask the database either.
    expect(mockDb.anonymousVisitor.findFirst).not.toHaveBeenCalled()
  })

  it('still identifies a caller carrying only one of the three signals', async () => {
    // The refusal above must be narrow. "Unidentifiable" means zero signals,
    // not "fewer than three" — a visitor who blocks the fingerprint and sits
    // behind an unresolvable address is still their cookie, and one signal is
    // the whole premise of the union.
    mockDb.anonymousVisitor.findFirst.mockResolvedValue(EXISTING)

    await expect(
      identifyVisitor({ cookieId: COOKIE_ID, ip: null, fingerprint: null })
    ).resolves.not.toBeNull()
    await expect(
      identifyVisitor({ cookieId: null, ip: IP, fingerprint: null })
    ).resolves.not.toBeNull()
    await expect(
      identifyVisitor({ cookieId: null, ip: null, fingerprint: FINGERPRINT })
    ).resolves.not.toBeNull()
  })

  it('treats a blank fingerprint as no signal rather than as a signal', async () => {
    mockDb.anonymousVisitor.create.mockResolvedValue(EXISTING)

    // `hashFingerprint('')` is null, so an empty string identifies nobody. It
    // must not sneak past the check as "well, they sent the field".
    const visitor = await identifyVisitor({ cookieId: '   ', ip: '', fingerprint: '' })

    expect(visitor).toBeNull()
    expect(mockDb.anonymousVisitor.create).not.toHaveBeenCalled()
  })

  it('adopts the winner when two requests from one new visitor race to insert', async () => {
    const { Prisma } = await import('@/generated/prisma/client')
    const conflict = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    })

    mockDb.anonymousVisitor.findFirst.mockResolvedValue(null)
    mockDb.anonymousVisitor.create.mockRejectedValue(conflict)
    mockDb.anonymousVisitor.findUnique.mockResolvedValue({ ...EXISTING, promptsUsed: 1 })

    const visitor = await identifyVisitor({ cookieId: COOKIE_ID, ip: IP, fingerprint: null })

    // Both requests are the same person, so both must land on the same quota.
    expect(visitor?.created).toBe(false)
    expect(visitor?.promptsUsed).toBe(1)
  })

  it('records the visit explicitly rather than through @updatedAt', async () => {
    mockDb.anonymousVisitor.findFirst.mockResolvedValue(EXISTING)

    await identifyVisitor({ cookieId: COOKIE_ID, ip: IP, fingerprint: null })

    const update = mockDb.anonymousVisitor.update.mock.lastCall?.[0] as {
      data: { lastSeenAt: Date }
    }

    expect(update.data.lastSeenAt).toBeInstanceOf(Date)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The concurrency guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A row that behaves the way Postgres behaves.
 *
 * `updateMany` yields to the event loop first, so every concurrent caller has
 * started before any of them applies. It then evaluates the predicate and the
 * increment in one synchronous step, which is exactly what a row lock buys:
 * whoever arrives second re-checks against the committed value.
 */
function rowUnderLock(initial: number) {
  const state = { promptsUsed: initial }

  const updateMany = vi.fn(
    async ({
      where,
      data,
    }: {
      where: { promptsUsed?: { lt?: number; gt?: number } }
      data: { promptsUsed: { increment?: number; decrement?: number } }
    }) => {
      await new Promise((resolve) => setImmediate(resolve))

      const below = where.promptsUsed?.lt
      const above = where.promptsUsed?.gt
      if (below !== undefined && !(state.promptsUsed < below)) return { count: 0 }
      if (above !== undefined && !(state.promptsUsed > above)) return { count: 0 }

      state.promptsUsed += data.promptsUsed.increment ?? -(data.promptsUsed.decrement ?? 0)
      return { count: 1 }
    }
  )

  return { state, updateMany }
}

describe('consumePrompt', () => {
  it('claims the prompt with a predicate and an increment, in one statement', async () => {
    mockDb.anonymousVisitor.updateMany.mockResolvedValue({ count: 1 })

    await consumePrompt(VISITOR_ID, 1)

    const call = mockDb.anonymousVisitor.updateMany.mock.lastCall?.[0] as {
      where: { id: string; promptsUsed: { lt: number } }
      data: { promptsUsed: { increment: number } }
    }

    // Both halves are load-bearing. The predicate is what Postgres re-evaluates
    // under the row lock; the increment is what stops a computed literal
    // clobbering a concurrent write.
    expect(call.where).toEqual({ id: VISITOR_ID, promptsUsed: { lt: 1 } })
    expect(call.data.promptsUsed).toEqual({ increment: 1 })
  })

  it('lets exactly one of five simultaneous requests through', async () => {
    const row = rowUnderLock(0)
    mockDb.anonymousVisitor.updateMany.mockImplementation(row.updateMany)

    const results = await Promise.all(
      Array.from({ length: 5 }, () => consumePrompt(VISITOR_ID, ANONYMOUS_PROMPT_LIMIT))
    )

    // Five tabs opened at once is the whole attack, and it costs nothing to run.
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(row.state.promptsUsed).toBe(1)
  })

  it('refuses once the quota is already spent', async () => {
    const row = rowUnderLock(1)
    mockDb.anonymousVisitor.updateMany.mockImplementation(row.updateMany)

    await expect(consumePrompt(VISITOR_ID, 1)).resolves.toBe(false)
    expect(row.state.promptsUsed).toBe(1)
  })

  it('refuses everything when ops sets the limit to zero', async () => {
    const row = rowUnderLock(0)
    mockDb.anonymousVisitor.updateMany.mockImplementation(row.updateMany)

    await expect(consumePrompt(VISITOR_ID, 0)).resolves.toBe(false)
    expect(row.state.promptsUsed).toBe(0)
  })

  it('would catch a read-then-write implementation', async () => {
    // The control experiment. Without it, the test above proves only that this
    // harness cannot observe the race — so here is the naive version that
    // `consumePrompt` deliberately is not, run against the same kind of row.
    const row = rowUnderLock(0)

    const naiveConsume = async (limit: number): Promise<boolean> => {
      const current = await Promise.resolve(row.state.promptsUsed)
      await new Promise((resolve) => setImmediate(resolve))
      if (current >= limit) return false
      row.state.promptsUsed = current + 1
      return true
    }

    const results = await Promise.all(Array.from({ length: 5 }, () => naiveConsume(1)))

    expect(results.filter(Boolean).length).toBeGreaterThan(1)
  })
})

describe('refundPrompt', () => {
  it('cannot push the counter below zero', async () => {
    const row = rowUnderLock(0)
    mockDb.anonymousVisitor.updateMany.mockImplementation(row.updateMany)

    await refundPrompt(VISITOR_ID)

    const call = mockDb.anonymousVisitor.updateMany.mock.lastCall?.[0] as {
      where: { promptsUsed: { gt: number } }
    }

    expect(call.where.promptsUsed).toEqual({ gt: 0 })
    expect(row.state.promptsUsed).toBe(0)
  })

  it('hands a spent prompt back after a failed generation', async () => {
    const row = rowUnderLock(1)
    mockDb.anonymousVisitor.updateMany.mockImplementation(row.updateMany)

    await refundPrompt(VISITOR_ID)

    expect(row.state.promptsUsed).toBe(0)
  })
})

describe('convertVisitor', () => {
  it('claims an unconverted visitor for the new account', async () => {
    mockDb.anonymousVisitor.updateMany.mockResolvedValue({ count: 1 })

    await expect(convertVisitor(VISITOR_ID, USER_ID)).resolves.toBe(true)

    const call = mockDb.anonymousVisitor.updateMany.mock.lastCall?.[0] as {
      where: { id: string; convertedUserId: null }
    }

    // Guarded, so one teaser session cannot be adopted by a second account.
    expect(call.where).toEqual({ id: VISITOR_ID, convertedUserId: null })
  })

  it('reports "nothing to do" rather than failing a signup', async () => {
    mockDb.anonymousVisitor.updateMany.mockResolvedValue({ count: 0 })

    await expect(convertVisitor(VISITOR_ID, USER_ID)).resolves.toBe(false)
  })
})
