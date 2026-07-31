import { randomUUID } from 'node:crypto'
import type { Prisma } from '@/generated/prisma/client'
import { AdminStatus, UserStatus, type AdminRole } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { env, type Env } from '@/lib/env'
import { generateOpaqueToken, hashIp, hashToken } from './crypto'
import { signAccessToken, type AccessClaims } from './jwt'

/**
 * Refresh-session lifecycle.
 *
 * A session is a *family* of refresh tokens descended from one login. Every use
 * of a refresh token consumes it and issues a successor in the same family, so
 * a token is valid exactly once. The family id doubles as the session id and is
 * what gets embedded as `sid` in access tokens.
 *
 * Rotation is what makes a stolen refresh token survivable. If an attacker
 * copies a token and the legitimate client later rotates it, the attacker's
 * copy is already revoked — presenting it proves a duplicate exists, and the
 * entire family is destroyed. The converse also holds: if the attacker rotates
 * first, the legitimate client's next request trips the same detection. Either
 * way the theft ends in a forced re-login rather than silent indefinite access.
 *
 * Only SHA-256 hashes of tokens are persisted; the raw value is returned to the
 * caller once and never stored.
 */

export interface IssuedSession {
  accessToken: string
  refreshToken: string
  /** Lifetime of `accessToken` in seconds — the refresh token outlives it. */
  expiresIn: number
  /** The token family, also the `sid` claim. Stable across rotations. */
  sessionId: string
}

export interface RequestContext {
  ip?: string | null
  userAgent?: string | null
}

/** User agents are attacker-controlled and unbounded; keep only enough to compare. */
const MAX_USER_AGENT_LENGTH = 255

type Tx = Prisma.TransactionClient

/** The columns the rotation algorithm actually reasons about. */
interface StoredToken {
  id: string
  ownerId: string
  familyId: string
  expiresAt: Date
  /** Absolute deadline for the login, fixed when the family was created. */
  familyExpiresAt: Date
  revokedAt: Date | null
}

interface NewTokenRow {
  ownerId: string
  tokenHash: string
  familyId: string
  expiresAt: Date
  familyExpiresAt: Date
  userAgent: string | null
  ipHash: string | null
}

/**
 * The per-audience half of an otherwise identical algorithm.
 *
 * Travellers and staff live in separate tables with separate status enums, but
 * the *order of security checks* must never diverge between them. Isolating the
 * table-specific queries behind this interface keeps that ordering in a single
 * implementation, so a fix cannot land for one audience and be forgotten for
 * the other.
 */
interface SessionStore {
  findByHash(tx: Tx, tokenHash: string): Promise<StoredToken | null>
  /** Kill every still-live token in a family. Used only on reuse detection. */
  revokeFamily(tx: Tx, familyId: string, now: Date): Promise<void>
  /** Claims for an owner still permitted to refresh, or null. */
  activeClaims(tx: Tx, ownerId: string, sessionId: string): Promise<AccessClaims | null>
  insert(tx: Tx, row: NewTokenRow): Promise<string>
  /**
   * Consume a token in favour of its successor. Guarded on the token still
   * being unrevoked, so two concurrent refreshes cannot both win and split the
   * family into two live chains. Returns false if this call lost that race.
   */
  markRotated(tx: Tx, tokenId: string, successorId: string, now: Date): Promise<boolean>
  /**
   * Idempotent logout. Revokes the presented token's whole family, not just the
   * row itself: if the token has already been rotated, the live successor is
   * the one that has to die, and revoking only the presented row would leave a
   * thief's session running while telling the victim they had logged out.
   */
  revokeByHash(tokenHash: string, now: Date): Promise<void>
}

const userStore: SessionStore = {
  async findByHash(tx, tokenHash) {
    const row = await tx.userRefreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userId: true,
        familyId: true,
        expiresAt: true,
        familyExpiresAt: true,
        revokedAt: true,
      },
    })
    return row === null ? null : { ...row, ownerId: row.userId }
  },

  async revokeFamily(tx, familyId, now) {
    await tx.userRefreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    })
  },

  async activeClaims(tx, ownerId, sessionId) {
    const user = await tx.user.findUnique({
      where: { id: ownerId },
      select: { id: true, status: true },
    })
    if (user === null || user.status !== UserStatus.ACTIVE) return null
    return { audience: 'user', userId: user.id, sessionId }
  },

  async insert(tx, row) {
    const created = await tx.userRefreshToken.create({
      data: {
        userId: row.ownerId,
        tokenHash: row.tokenHash,
        familyId: row.familyId,
        expiresAt: row.expiresAt,
        familyExpiresAt: row.familyExpiresAt,
        userAgent: row.userAgent,
        ipHash: row.ipHash,
      },
      select: { id: true },
    })
    return created.id
  },

  async markRotated(tx, tokenId, successorId, now) {
    const { count } = await tx.userRefreshToken.updateMany({
      where: { id: tokenId, revokedAt: null },
      data: { revokedAt: now, replacedByTokenId: successorId },
    })
    return count === 1
  },

  async revokeByHash(tokenHash, now) {
    await db.$transaction(async (tx) => {
      // Deliberately unfiltered on revokedAt: the presented token may already
      // have been rotated, and that is exactly the case that matters.
      const row = await tx.userRefreshToken.findUnique({
        where: { tokenHash },
        select: { familyId: true },
      })
      if (row === null) return
      await tx.userRefreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: now },
      })
    })
  },
}

const adminStore: SessionStore = {
  async findByHash(tx, tokenHash) {
    const row = await tx.adminRefreshToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        adminUserId: true,
        familyId: true,
        expiresAt: true,
        familyExpiresAt: true,
        revokedAt: true,
      },
    })
    return row === null ? null : { ...row, ownerId: row.adminUserId }
  },

  async revokeFamily(tx, familyId, now) {
    await tx.adminRefreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    })
  },

  async activeClaims(tx, ownerId, sessionId) {
    const admin = await tx.adminUser.findUnique({
      where: { id: ownerId },
      select: { id: true, role: true, status: true },
    })
    if (admin === null || admin.status !== AdminStatus.ACTIVE) return null
    // Role is re-read rather than carried over from the old token, so a
    // demotion takes effect on the next refresh instead of at end of session.
    return { audience: 'admin', adminUserId: admin.id, role: admin.role, sessionId }
  },

  async insert(tx, row) {
    const created = await tx.adminRefreshToken.create({
      data: {
        adminUserId: row.ownerId,
        tokenHash: row.tokenHash,
        familyId: row.familyId,
        expiresAt: row.expiresAt,
        familyExpiresAt: row.familyExpiresAt,
        userAgent: row.userAgent,
        ipHash: row.ipHash,
      },
      select: { id: true },
    })
    return created.id
  },

  async markRotated(tx, tokenId, successorId, now) {
    const { count } = await tx.adminRefreshToken.updateMany({
      where: { id: tokenId, revokedAt: null },
      data: { revokedAt: now, replacedByTokenId: successorId },
    })
    return count === 1
  },

  async revokeByHash(tokenHash, now) {
    await db.$transaction(async (tx) => {
      const row = await tx.adminRefreshToken.findUnique({
        where: { tokenHash },
        select: { familyId: true },
      })
      if (row === null) return
      await tx.adminRefreshToken.updateMany({
        where: { familyId: row.familyId, revokedAt: null },
        data: { revokedAt: now },
      })
    })
  },
}

/**
 * Signals that another request consumed this token first. Thrown rather than
 * returned so the successor row created moments earlier is rolled back with the
 * rest of the transaction; the caller still sees a plain null.
 */
class ConcurrentRotation extends Error {}

/**
 * When a login started now would finally have to re-authenticate.
 *
 * Computed once at login and then carried, never recomputed, so refreshing
 * cannot push it further out.
 */
function absoluteDeadline(config: Env): Date {
  return new Date(Date.now() + config.AUTH_SESSION_MAX_SECONDS * 1000)
}

function fingerprint(ctx: RequestContext): Pick<NewTokenRow, 'userAgent' | 'ipHash'> {
  return {
    userAgent: ctx.userAgent ? ctx.userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
    ipHash: hashIp(ctx.ip),
  }
}

/**
 * Persist one refresh token and mint the matching access token.
 *
 * Returns the new row id alongside the session because rotation needs it to
 * link the consumed token to its successor.
 */
async function startSession(
  store: SessionStore,
  client: Tx,
  config: Env,
  ownerId: string,
  familyId: string,
  familyExpiresAt: Date,
  claims: AccessClaims,
  ctx: RequestContext
): Promise<{ session: IssuedSession; tokenId: string }> {
  const rawToken = generateOpaqueToken()

  // Never let a successor outlive its family. Without the clamp, a rotation in
  // the final days of a session would hand back a token valid a full refresh
  // TTL beyond the absolute deadline, quietly defeating it.
  const slidingExpiry = new Date(Date.now() + config.AUTH_REFRESH_TTL_SECONDS * 1000)
  const expiresAt = slidingExpiry < familyExpiresAt ? slidingExpiry : familyExpiresAt

  const tokenId = await store.insert(client, {
    ownerId,
    tokenHash: hashToken(rawToken),
    familyId,
    expiresAt,
    familyExpiresAt,
    ...fingerprint(ctx),
  })

  return {
    tokenId,
    session: {
      accessToken: await signAccessToken(claims),
      refreshToken: rawToken,
      expiresIn: config.AUTH_ACCESS_TTL_SECONDS,
      sessionId: familyId,
    },
  }
}

/**
 * Exchange a refresh token for its successor.
 *
 * Every failure mode returns null. Callers must not distinguish them in their
 * response: telling an attacker whether a token was unknown, expired, or
 * already burnt hands them a probing oracle.
 */
async function rotate(
  store: SessionStore,
  rawRefreshToken: string,
  ctx: RequestContext
): Promise<IssuedSession | null> {
  // Read configuration before opening the transaction so a misconfigured
  // deployment fails without having touched a row.
  const config = env()
  const tokenHash = hashToken(rawRefreshToken)

  try {
    return await db.$transaction(async (tx) => {
      const presented = await store.findByHash(tx, tokenHash)
      if (presented === null) return null

      const now = new Date()

      // Reuse is checked BEFORE expiry, and the order is load-bearing.
      //
      // A revoked token proves a duplicate of it exists, and that fact does not
      // decay when the copy in hand goes stale. Rotation refreshes the
      // successor's expiry, so a thief who rotates every few weeks keeps a
      // permanently live branch while the victim's original ages out. Checking
      // expiry first would refuse that victim's eventual visit as merely
      // "expired" and never fire the detection — discarding the one signal that
      // would have killed the attacker's branch.
      if (presented.revokedAt !== null) {
        // REUSE DETECTED. We cannot tell whether the attacker or the legitimate
        // client is holding the live successor, so the whole family is destroyed
        // and both are forced to re-authenticate.
        //
        // This returns normally rather than throwing: the revocation must
        // commit, not roll back alongside the refusal.
        await store.revokeFamily(tx, presented.familyId, now)
        return null
      }

      if (presented.expiresAt.getTime() <= now.getTime()) return null

      // The absolute ceiling on this login. Rotation resets the sliding window
      // but can never move this, so a session eventually demands the password
      // again no matter how diligently it is refreshed.
      if (presented.familyExpiresAt.getTime() <= now.getTime()) return null

      // Re-read the account on every refresh. Access tokens are not checked
      // against the database, so this is the only point at which a suspension
      // takes hold — without it a suspended account could refresh its way to a
      // fresh access token indefinitely.
      const claims = await store.activeClaims(tx, presented.ownerId, presented.familyId)
      if (claims === null) return null

      const { session, tokenId } = await startSession(
        store,
        tx,
        config,
        presented.ownerId,
        presented.familyId,
        // Carried over unchanged — this is what makes the ceiling absolute.
        presented.familyExpiresAt,
        claims,
        ctx
      )

      const consumed = await store.markRotated(tx, presented.id, tokenId, now)
      if (!consumed) throw new ConcurrentRotation()

      return session
    })
  } catch (error) {
    if (error instanceof ConcurrentRotation) return null
    throw error
  }
}

/** Begin a traveller session. Call only after credentials have been verified. */
export async function issueUserSession(
  userId: string,
  ctx: RequestContext
): Promise<IssuedSession> {
  const config = env()
  const familyId = randomUUID()
  const { session } = await startSession(
    userStore,
    db,
    config,
    userId,
    familyId,
    absoluteDeadline(config),
    { audience: 'user', userId, sessionId: familyId },
    ctx
  )
  return session
}

export async function rotateUserSession(
  rawRefreshToken: string,
  ctx: RequestContext
): Promise<IssuedSession | null> {
  return rotate(userStore, rawRefreshToken, ctx)
}

/** Log out. Unknown or already-revoked tokens are a no-op, never an error. */
export async function revokeUserSession(rawRefreshToken: string): Promise<void> {
  await userStore.revokeByHash(hashToken(rawRefreshToken), new Date())
}

/** Begin a staff session. Call only after credentials have been verified. */
export async function issueAdminSession(
  adminUserId: string,
  role: AdminRole,
  ctx: RequestContext
): Promise<IssuedSession> {
  const config = env()
  const familyId = randomUUID()
  const { session } = await startSession(
    adminStore,
    db,
    config,
    adminUserId,
    familyId,
    absoluteDeadline(config),
    { audience: 'admin', adminUserId, role, sessionId: familyId },
    ctx
  )
  return session
}

export async function rotateAdminSession(
  rawRefreshToken: string,
  ctx: RequestContext
): Promise<IssuedSession | null> {
  return rotate(adminStore, rawRefreshToken, ctx)
}

/** Log out. Unknown or already-revoked tokens are a no-op, never an error. */
export async function revokeAdminSession(rawRefreshToken: string): Promise<void> {
  await adminStore.revokeByHash(hashToken(rawRefreshToken), new Date())
}
