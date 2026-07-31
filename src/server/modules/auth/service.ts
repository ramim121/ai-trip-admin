import type { Prisma } from '@/generated/prisma/client'
import { db } from '@/lib/db'
import { env } from '@/lib/env'
import { generateOpaqueToken, hashIp, hashPassword, hashToken } from '@/server/auth/crypto'
import type { IssuedSession } from '@/server/auth/tokens'
import { badRequest, unauthorized, type ApiError } from '@/server/http/errors'
import type { PublicAdmin, PublicUser, TokenPair } from './schema'

/**
 * The parts of the auth endpoints that are not HTTP.
 *
 * Two jobs: turning database rows into the public shapes without ever letting a
 * secret column ride along, and running the password-reset lifecycle. Keeping
 * both here means the eleven route files stay short enough to read in one go,
 * which is the only reliable way to notice that one of them is missing a check.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Projections
//
// The selects and the mappers are both written out field by field. A `select`
// alone is not enough: a login needs `passwordHash` in the same query, so any
// response built by spreading that row would carry it. A mapper alone is not
// enough either, because the hash would still cross the wire from Postgres on
// every read. Both, and neither spreads a Prisma row.
// ─────────────────────────────────────────────────────────────────────────────

export const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  emailVerifiedAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect

export const PUBLIC_ADMIN_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  avatarUrl: true,
} satisfies Prisma.AdminUserSelect

/** Exactly what `PUBLIC_USER_SELECT` returns. */
export interface PublicUserRow {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  emailVerifiedAt: Date | null
  createdAt: Date
}

/** Exactly what `PUBLIC_ADMIN_SELECT` returns. */
export interface PublicAdminRow {
  id: string
  email: string
  name: string
  role: PublicAdmin['role']
  avatarUrl: string | null
}

export function toPublicUser(row: PublicUserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    // A boolean, not the timestamp: when someone confirmed their address is an
    // operational detail, and clients only ever branch on the fact.
    emailVerified: row.emailVerifiedAt !== null,
    createdAt: row.createdAt.toISOString(),
  }
}

export function toPublicAdmin(row: PublicAdminRow): PublicAdmin {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    avatarUrl: row.avatarUrl,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session envelopes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three token fields, and only those.
 *
 * `IssuedSession` also carries `sessionId`. That is internal — it names the
 * refresh-token *family*, and publishing it would let a client refer to a
 * session it holds no token for. Listing the fields out rather than spreading
 * and deleting is what stops a future field on `IssuedSession` from appearing
 * in the response by default.
 */
export function tokenPair(session: IssuedSession): TokenPair {
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresIn: session.expiresIn,
  }
}

export function userSessionResponse(
  row: PublicUserRow,
  session: IssuedSession
): TokenPair & { user: PublicUser } {
  return { user: toPublicUser(row), ...tokenPair(session) }
}

export function adminSessionResponse(
  row: PublicAdminRow,
  session: IssuedSession
): TokenPair & { admin: PublicAdmin } {
  return { admin: toPublicAdmin(row), ...tokenPair(session) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusals
//
// One message per failure class, shared by every branch that can produce it.
// The wording lives in exactly one place, which is the whole point: a login
// that answers "no such account" for one input and "wrong password" for another
// is an account-enumeration oracle no matter how even the timing is.
// ─────────────────────────────────────────────────────────────────────────────

export function invalidCredentials(): ApiError {
  return unauthorized('Email or password is incorrect.')
}

export function invalidRefreshToken(): ApiError {
  return unauthorized('The refresh token is invalid, expired, or has already been used.')
}

/**
 * 400 rather than 401: the token arrived as part of the payload, not as a
 * credential for this request, so it is the body that is unacceptable. `path`
 * points the client's form at the right field.
 */
export function invalidResetToken(): ApiError {
  return badRequest('This password reset link is invalid, expired, or has already been used.', [
    { path: 'token', message: 'Invalid or expired reset token.' },
  ])
}

// ─────────────────────────────────────────────────────────────────────────────
// Password reset
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One hour.
 *
 * Long enough to survive a slow mail relay and a user who reads their inbox
 * after lunch; short enough that a link sitting in a mailbox backup, a shared
 * screenshot or a proxy log stops being a credential quickly.
 */
export const PASSWORD_RESET_TTL_SECONDS = 60 * 60

/**
 * Wording for the 202 — identical for a registered and an unregistered address.
 * See the route for why.
 */
export const PASSWORD_RESET_ACCEPTED = {
  message: 'If an account exists for that address, a password reset link has been sent.',
}

/**
 * Mint a reset token and persist only its hash.
 *
 * Any earlier link for the same user is burned first. Two live links mean two
 * chances for the older one to be found in an inbox and used; the newest
 * request is the one the user is actually looking at.
 */
export async function issuePasswordReset(userId: string, ip: string | null): Promise<string> {
  const rawToken = generateOpaqueToken()
  const now = new Date()

  await db.$transaction([
    db.passwordReset.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    }),
    db.passwordReset.create({
      data: {
        userId,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_SECONDS * 1000),
        ipHash: hashIp(ip),
      },
      select: { id: true },
    }),
  ])

  return rawToken
}

/**
 * Get the link to the user.
 *
 * TODO(phase-5): replace this with the transactional mail layer. That phase
 * owns provider configuration, templating and delivery retries. This function
 * is the single seam it has to take over — nothing outside it knows how a reset
 * link reaches anybody.
 *
 * Until then the link is printed, and only outside production. Logging a live
 * password-reset token to stdout in production would copy a working credential
 * into every log aggregator and shipping pipeline we have.
 */
export function deliverPasswordResetLink(email: string, rawToken: string): void {
  const config = env()
  if (config.NODE_ENV !== 'development') return

  const link = `${config.PUBLIC_WEB_ORIGIN}/reset-password?token=${encodeURIComponent(rawToken)}`
  console.log(`[auth] password reset for ${email} (dev only — no mail provider yet):\n  ${link}`)
}

/**
 * Spend a reset token: set the new password and end every existing session.
 *
 * Returns the user id on success, or null for any refusal. The caller must not
 * distinguish unknown from expired from already-used — all three answer
 * identically, or the endpoint becomes a way to test whether a token found
 * somewhere was ever real.
 *
 * The lookup is a unique-index hit on the SHA-256 of the token, so no
 * constant-time comparison is needed: we never compare the secret ourselves,
 * and 256 bits of CSPRNG output has no low-entropy structure for a timing
 * signal to narrow down.
 */
export async function consumePasswordReset(
  rawToken: string,
  newPassword: string
): Promise<string | null> {
  const reset = await db.passwordReset.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
  })

  if (reset === null) return null

  const now = new Date()
  if (reset.usedAt !== null || reset.expiresAt.getTime() <= now.getTime()) return null

  // Hash only after the token has been accepted, never before: Argon2 is
  // deliberately expensive, and hashing first would let anyone spend a
  // CPU-second of ours per garbage token they post.
  const passwordHash = await hashPassword(newPassword)

  return db.$transaction(async (tx) => {
    // Guarded on the row still being unused, so two requests racing on the same
    // link cannot both apply a password. The loser is refused like any other
    // spent token.
    const claimed = await tx.passwordReset.updateMany({
      where: { id: reset.id, usedAt: null },
      data: { usedAt: now },
    })
    if (claimed.count !== 1) return null

    await tx.user.update({
      where: { id: reset.userId },
      data: { passwordHash },
      select: { id: true },
    })

    // A reset exists because the account may be compromised. Leaving the
    // attacker's refresh token alive would make the new password pointless, so
    // every session dies and every device signs in again.
    await tx.userRefreshToken.updateMany({
      where: { userId: reset.userId, revokedAt: null },
      data: { revokedAt: now },
    })

    // Any other link still in flight is stale for the same reason.
    await tx.passwordReset.updateMany({
      where: { userId: reset.userId, usedAt: null },
      data: { usedAt: now },
    })

    return reset.userId
  })
}
