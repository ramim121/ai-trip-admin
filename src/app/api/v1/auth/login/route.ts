import type { NextRequest } from 'next/server'
import { UserStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { recordAudit } from '@/server/audit/log'
import { fakePasswordVerification, verifyPassword } from '@/server/auth/crypto'
import { issueUserSession } from '@/server/auth/tokens'
import { clientContext } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { LoginBody } from '@/server/modules/auth/schema'
import {
  invalidCredentials,
  PUBLIC_USER_SELECT,
  userSessionResponse,
} from '@/server/modules/auth/service'

/**
 * POST /api/v1/auth/login — exchange credentials for a session.
 *
 * Three different things can go wrong here — no such address, wrong password,
 * account not active — and all three produce the identical 401 with the
 * identical message. Which one it was is recorded in `audit_logs`, where we can
 * read it and the caller cannot.
 *
 * Timing is treated as part of the response. The unknown-address branch calls
 * `fakePasswordVerification()`, which burns one Argon2 verification, because
 * without it "no such user" would return in microseconds while a real attempt
 * takes tens of milliseconds — an enumeration oracle a stopwatch reads just as
 * well as an error message.
 *
 * TODO(phase-5): this endpoint needs per-address and per-IP rate limiting.
 * Constant-time refusal stops enumeration; it does nothing about someone
 * working through a password list.
 */
export const POST = route(async (req: NextRequest) => {
  const body = await parseJson(req, LoginBody)
  const ctx = clientContext(req)

  const user = await db.user.findUnique({
    where: { email: body.email },
    // `passwordHash` is fetched here and nowhere else. It is consumed by
    // verifyPassword below and never reaches userSessionResponse, which maps
    // the public fields explicitly rather than spreading this row.
    select: { ...PUBLIC_USER_SELECT, passwordHash: true, status: true },
  })

  if (user === null) {
    await fakePasswordVerification()
    await recordAudit({
      action: 'user.login_failed',
      entityType: 'user',
      after: { email: body.email, reason: 'unknown_email' },
      ...ctx,
    })
    throw invalidCredentials()
  }

  const passwordMatches = await verifyPassword(user.passwordHash, body.password)

  if (!passwordMatches) {
    await recordAudit({
      action: 'user.login_failed',
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      after: { email: user.email, reason: 'bad_password' },
      ...ctx,
    })
    throw invalidCredentials()
  }

  // Status is checked after the password, not before. Refusing a suspended
  // account without verifying the password would answer faster for suspended
  // users than for anyone else, and would tell someone holding a leaked
  // credential list which of their addresses are real but disabled.
  if (user.status !== UserStatus.ACTIVE) {
    await recordAudit({
      action: 'user.login_failed',
      entityType: 'user',
      entityId: user.id,
      userId: user.id,
      after: { email: user.email, reason: `account_${user.status.toLowerCase()}` },
      ...ctx,
    })
    // The same refusal as a wrong password. A suspended user learns nothing
    // from this response; support tells them, over a channel that has already
    // established who they are.
    throw invalidCredentials()
  }

  await db.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
    select: { id: true },
  })

  const session = await issueUserSession(user.id, ctx)

  return json(userSessionResponse(user, session))
})
