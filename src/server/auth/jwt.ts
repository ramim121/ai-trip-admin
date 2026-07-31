import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import type { AdminRole } from '@/generated/prisma/enums'
import { env } from '@/lib/env'

/**
 * Access-token signing and verification.
 *
 * Travellers and staff are separated twice over: by a distinct `aud` claim and
 * by a distinct signing secret. Either alone would be enough to reject a
 * cross-audience token, but the pair means a mistake in one layer — say, a
 * handler that forgets to check the audience — still cannot be exploited.
 *
 * Access tokens are short-lived and are NOT checked against the database on
 * each request; that is the point of them. Revocation happens at the refresh
 * layer, so the worst case after a logout is one access-token TTL of validity.
 */

const ISSUER = 'beyond-borders'
const ALGORITHM = 'HS256'

export type Audience = 'user' | 'admin'

export interface UserAccessClaims {
  audience: 'user'
  userId: string
  /** Refresh-token family this access token descends from. Recorded for audit. */
  sessionId: string
}

export interface AdminAccessClaims {
  audience: 'admin'
  adminUserId: string
  role: AdminRole
  sessionId: string
}

export type AccessClaims = UserAccessClaims | AdminAccessClaims

function secretFor(audience: Audience): Uint8Array {
  const config = env()
  return new TextEncoder().encode(
    audience === 'admin' ? config.AUTH_ADMIN_SECRET : config.AUTH_USER_SECRET
  )
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  const config = env()
  const subject = claims.audience === 'admin' ? claims.adminUserId : claims.userId

  const token = new SignJWT({
    sid: claims.sessionId,
    ...(claims.audience === 'admin' ? { role: claims.role } : {}),
  })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(subject)
    .setAudience(claims.audience)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${config.AUTH_ACCESS_TTL_SECONDS}s`)

  return token.sign(secretFor(claims.audience))
}

/**
 * Verify a token for one specific audience.
 *
 * Returns null on any failure — expired, wrong signature, wrong audience,
 * malformed. Callers turn that into a 401; they never learn which it was, since
 * distinguishing "expired" from "forged" only helps an attacker.
 */
export async function verifyAccessToken<A extends Audience>(
  token: string,
  audience: A
): Promise<(A extends 'admin' ? AdminAccessClaims : UserAccessClaims) | null> {
  try {
    const { payload } = await jwtVerify(token, secretFor(audience), {
      audience,
      issuer: ISSUER,
      algorithms: [ALGORITHM],
    })

    return toClaims(payload, audience) as
      | (A extends 'admin' ? AdminAccessClaims : UserAccessClaims)
      | null
  } catch {
    return null
  }
}

function toClaims(payload: JWTPayload, audience: Audience): AccessClaims | null {
  const subject = payload.sub
  const sessionId = payload.sid

  if (typeof subject !== 'string' || typeof sessionId !== 'string') return null

  if (audience === 'admin') {
    const role = payload.role
    // A token minted without a role would otherwise reach permission checks and
    // be compared against undefined.
    if (typeof role !== 'string') return null
    return { audience: 'admin', adminUserId: subject, role: role as AdminRole, sessionId }
  }

  return { audience: 'user', userId: subject, sessionId }
}
