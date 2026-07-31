import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetEnvCache } from '@/lib/env'
import { hashToken } from './crypto'
import { verifyAccessToken } from './jwt'
import {
  issueAdminSession,
  issueUserSession,
  revokeAdminSession,
  revokeUserSession,
  rotateAdminSession,
  rotateUserSession,
} from './tokens'

/**
 * The database is mocked wholesale. These tests are about the *decision* logic
 * — which checks run, in what order, and which rows get written — so a real
 * Postgres would only add flakiness and hide the assertions that matter.
 *
 * Crypto and JWT signing are NOT mocked: asserting that the persisted hash
 * really is the SHA-256 of the returned token, and that the `sid` claim really
 * survives a signature verification, is most of the point.
 */

const { mockDb } = vi.hoisted(() => {
  const tokenDelegate = () => ({
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  })

  return {
    mockDb: {
      user: { findUnique: vi.fn() },
      adminUser: { findUnique: vi.fn() },
      userRefreshToken: tokenDelegate(),
      adminRefreshToken: tokenDelegate(),
      $transaction: vi.fn(),
    },
  }
})

vi.mock('@/lib/db', () => ({ db: mockDb, disconnectDb: vi.fn() }))

process.env.DATABASE_URL =
  'postgresql://tester:not-a-real-password@localhost:5432/beyond_borders_test'
process.env.AUTH_USER_SECRET = 'test-user-secret-0123456789-abcdefghij'
process.env.AUTH_ADMIN_SECRET = 'test-admin-secret-0123456789-abcdefghij'
process.env.AUTH_ACCESS_TTL_SECONDS = '900'
process.env.AUTH_REFRESH_TTL_SECONDS = '2592000'
resetEnvCache()

const USER_ID = '019373d4-4a1b-7c3e-9f00-1111aaaa0001'
const ADMIN_ID = '019373d4-4a1b-7c3e-9f00-2222bbbb0002'
const FAMILY_ID = '019373d4-4a1b-7c3e-9f00-3333cccc0003'
const OLD_TOKEN_ID = '019373d4-4a1b-7c3e-9f00-4444dddd0004'
const NEW_TOKEN_ID = '019373d4-4a1b-7c3e-9f00-5555eeee0005'

const RAW_TOKEN = 'qN7dR2xKp0LmA4wZ8vBhT6yG1cE5sJfU9iO3nX7kQbM'
const CTX = { ip: '203.0.113.7', userAgent: 'Mozilla/5.0 (test runner)' }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const future = () => new Date(Date.now() + 60_000)
const past = () => new Date(Date.now() - 60_000)

interface CallSpy {
  mock: { lastCall?: unknown[] }
}

/** The `data` payload handed to the most recent `create()`. */
function createdRow(create: CallSpy): Record<string, unknown> {
  const args = create.mock.lastCall?.[0] as { data: Record<string, unknown> } | undefined
  if (!args) throw new Error('create() was never called')
  return args.data
}

/** Narrowing helper so assertions do not need non-null assertions. */
function assertIssued<T>(value: T | null): T {
  if (value === null) throw new Error('expected a session, got null')
  return value
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.$transaction.mockImplementation((run: (tx: typeof mockDb) => unknown) => run(mockDb))
})

describe('issueUserSession', () => {
  it('persists only the hash and returns the raw token once', async () => {
    mockDb.userRefreshToken.create.mockResolvedValue({ id: NEW_TOKEN_ID })

    const session = await issueUserSession(USER_ID, CTX)
    const row = createdRow(mockDb.userRefreshToken.create)

    expect(row.tokenHash).toBe(hashToken(session.refreshToken))
    expect(JSON.stringify(row)).not.toContain(session.refreshToken)
    expect(row.userId).toBe(USER_ID)
  })

  it('opens a fresh family and returns it as the session id', async () => {
    mockDb.userRefreshToken.create.mockResolvedValue({ id: NEW_TOKEN_ID })

    const first = await issueUserSession(USER_ID, CTX)
    const second = await issueUserSession(USER_ID, CTX)

    expect(first.sessionId).toMatch(UUID_PATTERN)
    expect(createdRow(mockDb.userRefreshToken.create).familyId).toBe(second.sessionId)
    // Two logins are two independent families; revoking one must not touch the other.
    expect(first.sessionId).not.toBe(second.sessionId)
  })

  it('embeds the family id as the sid claim of a verifiable access token', async () => {
    mockDb.userRefreshToken.create.mockResolvedValue({ id: NEW_TOKEN_ID })

    const session = await issueUserSession(USER_ID, CTX)
    const claims = await verifyAccessToken(session.accessToken, 'user')

    expect(claims).toEqual({ audience: 'user', userId: USER_ID, sessionId: session.sessionId })
    // A traveller token must not verify against the admin secret.
    expect(await verifyAccessToken(session.accessToken, 'admin')).toBeNull()
  })

  it('reports the access-token lifetime and dates the refresh token separately', async () => {
    mockDb.userRefreshToken.create.mockResolvedValue({ id: NEW_TOKEN_ID })

    const before = Date.now()
    const session = await issueUserSession(USER_ID, CTX)
    const expiresAt = createdRow(mockDb.userRefreshToken.create).expiresAt as Date

    expect(session.expiresIn).toBe(900)
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 2_592_000 * 1000)
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 2_592_000 * 1000)
  })

  it('pseudonymises the ip and truncates the user agent', async () => {
    mockDb.userRefreshToken.create.mockResolvedValue({ id: NEW_TOKEN_ID })

    await issueUserSession(USER_ID, { ip: '203.0.113.7', userAgent: 'U'.repeat(400) })
    const row = createdRow(mockDb.userRefreshToken.create)

    expect(row.ipHash).not.toBe('203.0.113.7')
    expect(row.ipHash).toMatch(/^[0-9a-f]{32}$/)
    expect(row.userAgent).toHaveLength(255)
  })

  it('stores nulls when no request context is available', async () => {
    mockDb.userRefreshToken.create.mockResolvedValue({ id: NEW_TOKEN_ID })

    await issueUserSession(USER_ID, {})
    const row = createdRow(mockDb.userRefreshToken.create)

    expect(row.ipHash).toBeNull()
    expect(row.userAgent).toBeNull()
  })
})

describe('rotateUserSession — happy path', () => {
  beforeEach(() => {
    mockDb.userRefreshToken.findUnique.mockResolvedValue({
      id: OLD_TOKEN_ID,
      userId: USER_ID,
      familyId: FAMILY_ID,
      expiresAt: future(),
      familyExpiresAt: future(),
      revokedAt: null,
    })
    mockDb.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'ACTIVE' })
    mockDb.userRefreshToken.create.mockResolvedValue({ id: NEW_TOKEN_ID })
    mockDb.userRefreshToken.updateMany.mockResolvedValue({ count: 1 })
  })

  it('looks the token up by hash, never by raw value', async () => {
    await rotateUserSession(RAW_TOKEN, CTX)

    expect(mockDb.userRefreshToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashToken(RAW_TOKEN) } })
    )
  })

  it('issues a different token in the same family', async () => {
    const session = assertIssued(await rotateUserSession(RAW_TOKEN, CTX))
    const row = createdRow(mockDb.userRefreshToken.create)

    expect(session.refreshToken).not.toBe(RAW_TOKEN)
    expect(session.sessionId).toBe(FAMILY_ID)
    expect(row.familyId).toBe(FAMILY_ID)
    expect(row.tokenHash).toBe(hashToken(session.refreshToken))
  })

  it('consumes the presented token and links it to its successor', async () => {
    await rotateUserSession(RAW_TOKEN, CTX)

    expect(mockDb.userRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { id: OLD_TOKEN_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date), replacedByTokenId: NEW_TOKEN_ID },
    })
  })

  it('runs the whole exchange inside one transaction', async () => {
    await rotateUserSession(RAW_TOKEN, CTX)

    expect(mockDb.$transaction).toHaveBeenCalledTimes(1)
    expect(mockDb.$transaction).toHaveBeenCalledWith(expect.any(Function))
  })

  it('keeps the sid claim stable across the rotation', async () => {
    const session = assertIssued(await rotateUserSession(RAW_TOKEN, CTX))

    expect(await verifyAccessToken(session.accessToken, 'user')).toEqual({
      audience: 'user',
      userId: USER_ID,
      sessionId: FAMILY_ID,
    })
  })

  it('refuses when another request consumed the same token first', async () => {
    // The guarded update matches zero rows because the row is already revoked.
    mockDb.userRefreshToken.updateMany.mockResolvedValue({ count: 0 })

    expect(await rotateUserSession(RAW_TOKEN, CTX)).toBeNull()
  })
})

describe('rotateUserSession — reuse detection', () => {
  beforeEach(() => {
    mockDb.userRefreshToken.findUnique.mockResolvedValue({
      id: OLD_TOKEN_ID,
      userId: USER_ID,
      familyId: FAMILY_ID,
      // Already rotated once: presenting it again means a copy exists.
      expiresAt: future(),
      familyExpiresAt: future(),
      revokedAt: past(),
    })
    mockDb.userRefreshToken.updateMany.mockResolvedValue({ count: 3 })
  })

  it('revokes every live token in the family', async () => {
    expect(await rotateUserSession(RAW_TOKEN, CTX)).toBeNull()

    expect(mockDb.userRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: FAMILY_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    })
  })

  it('does not rotate, and does not even look at the account', async () => {
    await rotateUserSession(RAW_TOKEN, CTX)

    expect(mockDb.userRefreshToken.create).not.toHaveBeenCalled()
    expect(mockDb.user.findUnique).not.toHaveBeenCalled()
  })

  it('leaves the family revocation committed rather than rolled back', async () => {
    // A thrown error would roll the revocation back with the refusal, so the
    // refusal must travel as a plain return value.
    await expect(rotateUserSession(RAW_TOKEN, CTX)).resolves.toBeNull()
    expect(mockDb.userRefreshToken.updateMany).toHaveBeenCalledTimes(1)
  })
})

describe('rotateUserSession — refusals', () => {
  it('returns null for an unknown token without writing anything', async () => {
    mockDb.userRefreshToken.findUnique.mockResolvedValue(null)

    expect(await rotateUserSession(RAW_TOKEN, CTX)).toBeNull()
    expect(mockDb.userRefreshToken.create).not.toHaveBeenCalled()
    expect(mockDb.userRefreshToken.updateMany).not.toHaveBeenCalled()
  })

  it('returns null for an expired token without writing anything', async () => {
    mockDb.userRefreshToken.findUnique.mockResolvedValue({
      id: OLD_TOKEN_ID,
      userId: USER_ID,
      familyId: FAMILY_ID,
      expiresAt: past(),
      familyExpiresAt: future(),
      revokedAt: null,
    })

    expect(await rotateUserSession(RAW_TOKEN, CTX)).toBeNull()
    expect(mockDb.userRefreshToken.create).not.toHaveBeenCalled()
    expect(mockDb.userRefreshToken.updateMany).not.toHaveBeenCalled()
  })

  it('detects reuse before expiry, so an expired replay still kills the family', async () => {
    // Ordering is load-bearing. A thief who rotates every few weeks keeps a
    // permanently fresh branch while the victim's original token ages out; if
    // expiry were evaluated first, the victim's eventual return would be
    // refused as merely "expired" and the theft would never be detected.
    // A revoked token proves a duplicate exists, and that stays true after it
    // goes stale.
    mockDb.userRefreshToken.findUnique.mockResolvedValue({
      id: OLD_TOKEN_ID,
      userId: USER_ID,
      familyId: FAMILY_ID,
      expiresAt: past(),
      familyExpiresAt: future(),
      revokedAt: past(),
    })

    expect(await rotateUserSession(RAW_TOKEN, CTX)).toBeNull()
    expect(mockDb.userRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: FAMILY_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    })
  })

  it('refuses once the family hits its absolute deadline, however fresh the token', async () => {
    // The sliding refresh window is still open — only the ceiling has passed.
    // This is the case that stops an indefinitely-refreshed stolen token: no
    // amount of diligent rotation can move familyExpiresAt.
    mockDb.userRefreshToken.findUnique.mockResolvedValue({
      id: OLD_TOKEN_ID,
      userId: USER_ID,
      familyId: FAMILY_ID,
      expiresAt: future(),
      familyExpiresAt: past(),
      revokedAt: null,
    })

    expect(await rotateUserSession(RAW_TOKEN, CTX)).toBeNull()
    expect(mockDb.userRefreshToken.create).not.toHaveBeenCalled()
  })

  it('never lets a successor outlive its family deadline', async () => {
    // Rotating near the ceiling must clamp the new token to it, not hand back
    // a full refresh TTL that reaches past the deadline.
    const ceiling = new Date(Date.now() + 60_000)
    mockDb.userRefreshToken.findUnique.mockResolvedValue({
      id: OLD_TOKEN_ID,
      userId: USER_ID,
      familyId: FAMILY_ID,
      expiresAt: future(),
      familyExpiresAt: ceiling,
      revokedAt: null,
    })
    mockDb.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'ACTIVE' })
    mockDb.userRefreshToken.create.mockResolvedValue({ id: NEW_TOKEN_ID })
    mockDb.userRefreshToken.updateMany.mockResolvedValue({ count: 1 })

    await rotateUserSession(RAW_TOKEN, CTX)

    const written = mockDb.userRefreshToken.create.mock.calls[0][0].data
    expect(written.expiresAt.getTime()).toBeLessThanOrEqual(ceiling.getTime())
    expect(written.familyExpiresAt.getTime()).toBe(ceiling.getTime())
  })

  it.each(['SUSPENDED', 'DELETED'])(
    'refuses a %s account instead of minting a fresh token',
    async (status) => {
      mockDb.userRefreshToken.findUnique.mockResolvedValue({
        id: OLD_TOKEN_ID,
        userId: USER_ID,
        familyId: FAMILY_ID,
        expiresAt: future(),
        familyExpiresAt: future(),
        revokedAt: null,
      })
      mockDb.user.findUnique.mockResolvedValue({ id: USER_ID, status })

      expect(await rotateUserSession(RAW_TOKEN, CTX)).toBeNull()
      expect(mockDb.userRefreshToken.create).not.toHaveBeenCalled()
      expect(mockDb.userRefreshToken.updateMany).not.toHaveBeenCalled()
    }
  )

  it('refuses when the account row has disappeared', async () => {
    mockDb.userRefreshToken.findUnique.mockResolvedValue({
      id: OLD_TOKEN_ID,
      userId: USER_ID,
      familyId: FAMILY_ID,
      expiresAt: future(),
      familyExpiresAt: future(),
      revokedAt: null,
    })
    mockDb.user.findUnique.mockResolvedValue(null)

    expect(await rotateUserSession(RAW_TOKEN, CTX)).toBeNull()
    expect(mockDb.userRefreshToken.create).not.toHaveBeenCalled()
  })

  it('re-reads the account on every refresh', async () => {
    mockDb.userRefreshToken.findUnique.mockResolvedValue({
      id: OLD_TOKEN_ID,
      userId: USER_ID,
      familyId: FAMILY_ID,
      expiresAt: future(),
      familyExpiresAt: future(),
      revokedAt: null,
    })
    mockDb.user.findUnique.mockResolvedValue({ id: USER_ID, status: 'ACTIVE' })
    mockDb.userRefreshToken.create.mockResolvedValue({ id: NEW_TOKEN_ID })
    mockDb.userRefreshToken.updateMany.mockResolvedValue({ count: 1 })

    await rotateUserSession(RAW_TOKEN, CTX)

    expect(mockDb.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: USER_ID } })
    )
  })
})

describe('revokeUserSession', () => {
  it('revokes the whole family, not just the presented row', async () => {
    mockDb.userRefreshToken.findUnique.mockResolvedValue({ familyId: FAMILY_ID })
    mockDb.userRefreshToken.updateMany.mockResolvedValue({ count: 1 })

    await revokeUserSession(RAW_TOKEN)

    expect(mockDb.userRefreshToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashToken(RAW_TOKEN) },
      select: { familyId: true },
    })
    expect(mockDb.userRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: FAMILY_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    })
  })

  it('logs out the live successor when the presented token was already rotated', async () => {
    // The theft scenario: an attacker rotated the stolen token, so the copy the
    // victim still holds is revoked and its successor is live. Matching on the
    // presented row alone would revoke nothing, return 204, and leave the
    // attacker's session running behind a "you have been logged out" screen.
    mockDb.userRefreshToken.findUnique.mockResolvedValue({ familyId: FAMILY_ID })
    mockDb.userRefreshToken.updateMany.mockResolvedValue({ count: 1 })

    await revokeUserSession(RAW_TOKEN)

    const [call] = mockDb.userRefreshToken.updateMany.mock.calls
    expect(call[0].where).not.toHaveProperty('tokenHash')
    expect(call[0].where.familyId).toBe(FAMILY_ID)
  })

  it('is a no-op for an unknown token', async () => {
    mockDb.userRefreshToken.findUnique.mockResolvedValue(null)

    await expect(revokeUserSession(RAW_TOKEN)).resolves.toBeUndefined()
    await expect(revokeUserSession(RAW_TOKEN)).resolves.toBeUndefined()
    expect(mockDb.userRefreshToken.updateMany).not.toHaveBeenCalled()
  })
})

describe('admin sessions', () => {
  it('issues a staff session carrying the role', async () => {
    mockDb.adminRefreshToken.create.mockResolvedValue({ id: NEW_TOKEN_ID })

    const session = await issueAdminSession(ADMIN_ID, 'OPS', CTX)
    const row = createdRow(mockDb.adminRefreshToken.create)

    expect(row.adminUserId).toBe(ADMIN_ID)
    expect(row.tokenHash).toBe(hashToken(session.refreshToken))
    expect(await verifyAccessToken(session.accessToken, 'admin')).toEqual({
      audience: 'admin',
      adminUserId: ADMIN_ID,
      role: 'OPS',
      sessionId: session.sessionId,
    })
  })

  it('takes the role from the database on rotation, not from the old token', async () => {
    mockDb.adminRefreshToken.findUnique.mockResolvedValue({
      id: OLD_TOKEN_ID,
      adminUserId: ADMIN_ID,
      familyId: FAMILY_ID,
      expiresAt: future(),
      familyExpiresAt: future(),
      revokedAt: null,
    })
    // Demoted since the session began.
    mockDb.adminUser.findUnique.mockResolvedValue({
      id: ADMIN_ID,
      role: 'SUPPORT',
      status: 'ACTIVE',
    })
    mockDb.adminRefreshToken.create.mockResolvedValue({ id: NEW_TOKEN_ID })
    mockDb.adminRefreshToken.updateMany.mockResolvedValue({ count: 1 })

    const session = assertIssued(await rotateAdminSession(RAW_TOKEN, CTX))

    expect(await verifyAccessToken(session.accessToken, 'admin')).toEqual({
      audience: 'admin',
      adminUserId: ADMIN_ID,
      role: 'SUPPORT',
      sessionId: FAMILY_ID,
    })
  })

  it('refuses a DISABLED admin', async () => {
    mockDb.adminRefreshToken.findUnique.mockResolvedValue({
      id: OLD_TOKEN_ID,
      adminUserId: ADMIN_ID,
      familyId: FAMILY_ID,
      expiresAt: future(),
      familyExpiresAt: future(),
      revokedAt: null,
    })
    mockDb.adminUser.findUnique.mockResolvedValue({
      id: ADMIN_ID,
      role: 'SUPER_ADMIN',
      status: 'DISABLED',
    })

    expect(await rotateAdminSession(RAW_TOKEN, CTX)).toBeNull()
    expect(mockDb.adminRefreshToken.create).not.toHaveBeenCalled()
  })

  it('applies reuse detection to the admin family', async () => {
    mockDb.adminRefreshToken.findUnique.mockResolvedValue({
      id: OLD_TOKEN_ID,
      adminUserId: ADMIN_ID,
      familyId: FAMILY_ID,
      expiresAt: future(),
      familyExpiresAt: future(),
      revokedAt: past(),
    })
    mockDb.adminRefreshToken.updateMany.mockResolvedValue({ count: 2 })

    expect(await rotateAdminSession(RAW_TOKEN, CTX)).toBeNull()
    expect(mockDb.adminRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: FAMILY_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    })
    expect(mockDb.adminRefreshToken.create).not.toHaveBeenCalled()
  })

  it('never touches the traveller tables', async () => {
    mockDb.adminRefreshToken.findUnique.mockResolvedValue(null)

    await rotateAdminSession(RAW_TOKEN, CTX)

    expect(mockDb.userRefreshToken.findUnique).not.toHaveBeenCalled()
    expect(mockDb.user.findUnique).not.toHaveBeenCalled()
  })

  it('revokes the whole family idempotently on logout', async () => {
    mockDb.adminRefreshToken.findUnique.mockResolvedValue({ familyId: FAMILY_ID })
    mockDb.adminRefreshToken.updateMany.mockResolvedValue({ count: 0 })

    await expect(revokeAdminSession(RAW_TOKEN)).resolves.toBeUndefined()
    expect(mockDb.adminRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: FAMILY_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    })
  })

  it('is a no-op when logging out an unknown admin token', async () => {
    mockDb.adminRefreshToken.findUnique.mockResolvedValue(null)

    await expect(revokeAdminSession(RAW_TOKEN)).resolves.toBeUndefined()
    expect(mockDb.adminRefreshToken.updateMany).not.toHaveBeenCalled()
  })
})
