import type { NextRequest } from 'next/server'
import { UserStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { clientContext } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { ForgotPasswordBody } from '@/server/modules/auth/schema'
import {
  deliverPasswordResetLink,
  issuePasswordReset,
  PASSWORD_RESET_ACCEPTED,
} from '@/server/modules/auth/service'

/**
 * POST /api/v1/auth/password/forgot — request a reset link.
 *
 * Always 202, always the same body. An endpoint that answered 404 for an
 * unregistered address would be a bulk membership test: paste in a breach dump,
 * read out which addresses hold accounts here. So the response says only that
 * the request was accepted, and the copy is phrased conditionally ("if an
 * account exists") so that the wording stays true in both cases rather than
 * becoming the tell that the status code no longer is.
 *
 * A row is written only when there is a user to write it for. Nothing is
 * created, and nothing is sent, for an address we do not know.
 *
 * TODO(phase-5): rate limit by address and by IP. This endpoint sends mail on
 * demand, so without a limit it is both a way to flood one person's inbox and a
 * way to spend our sending reputation.
 */
export const POST = route(async (req: NextRequest) => {
  const body = await parseJson(req, ForgotPasswordBody)
  const ctx = clientContext(req)

  const user = await db.user.findUnique({
    where: { email: body.email },
    select: { id: true, email: true, status: true },
  })

  // Suspended and deleted accounts get nothing. A reset link is a way back in,
  // and issuing one for an account we have disabled would undo the suspension.
  if (user !== null && user.status === UserStatus.ACTIVE) {
    const rawToken = await issuePasswordReset(user.id, ctx.ip)
    deliverPasswordResetLink(user.email, rawToken)
  }

  // Note what this function's shape implies: a known address costs an extra
  // insert, so it answers marginally slower. That difference is accepted rather
  // than papered over with decoy work. Unlike login, this is not a credential
  // check — the realistic attack is bulk enumeration, and a per-IP rate limit
  // answers that far better than matching the cost of every miss.
  return json(PASSWORD_RESET_ACCEPTED, 202)
})
