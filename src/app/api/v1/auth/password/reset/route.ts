import type { NextRequest } from 'next/server'
import { recordAudit } from '@/server/audit/log'
import { clientContext } from '@/server/http/guards'
import { noContent, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { ResetPasswordBody } from '@/server/modules/auth/schema'
import { consumePasswordReset, invalidResetToken } from '@/server/modules/auth/service'

/**
 * POST /api/v1/auth/password/reset — spend a reset link.
 *
 * The token is single-use, and the service enforces that with a guarded update
 * rather than a read-then-write, so two clicks on the same link cannot both set
 * a password.
 *
 * Succeeding here revokes every refresh token the account holds. A reset is
 * what someone does when they suspect their account is compromised, and a new
 * password that leaves the attacker's session alive has fixed nothing. The
 * legitimate user signs in again on each device; that is the intended cost.
 *
 * No session is issued in exchange. Returning tokens here would mean anyone who
 * intercepts a reset link is signed in merely by following it, with no second
 * step; the client sends the user to the login form instead.
 */
export const POST = route(async (req: NextRequest) => {
  const body = await parseJson(req, ResetPasswordBody)
  const ctx = clientContext(req)

  // Null covers unknown, expired, already-used and lost-race alike, and they
  // all answer with the same 400. Telling someone that a token they found was
  // "already used" confirms it was real.
  const userId = await consumePasswordReset(body.token, body.password)
  if (userId === null) throw invalidResetToken()

  await recordAudit({
    action: 'password.reset',
    entityType: 'user',
    entityId: userId,
    userId,
    // No token, no hash, no password — just that it happened, to whom, and
    // from where. schema.prisma asks for exactly that restraint.
    after: { allSessionsRevoked: true },
    ...ctx,
  })

  return noContent()
})
