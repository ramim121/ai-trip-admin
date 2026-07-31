import type { NextRequest } from 'next/server'
import { Prisma } from '@/generated/prisma/client'
import { db } from '@/lib/db'
import { recordAudit } from '@/server/audit/log'
import { hashPassword } from '@/server/auth/crypto'
import { issueUserSession } from '@/server/auth/tokens'
import { conflict } from '@/server/http/errors'
import { clientContext } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { RegisterBody } from '@/server/modules/auth/schema'
import { PUBLIC_USER_SELECT, userSessionResponse } from '@/server/modules/auth/service'

/** Postgres unique violation, surfaced by Prisma as a known request error. */
const UNIQUE_VIOLATION = 'P2002'

/**
 * POST /api/v1/auth/register — create a traveller account and sign them in.
 *
 * This is the one endpoint that admits an address is taken, and that is a
 * deliberate, bounded exception. Registration cannot both refuse a duplicate
 * and hide that it did so: the account either gets created or it does not, and
 * the caller has to be told which. Every other endpoint — login,
 * forgot-password — answers identically for known and unknown addresses, so
 * this stays the only place existence is observable, and it costs an attacker
 * an attempted signup per address rather than giving them a silent probe.
 */
export const POST = route(async (req: NextRequest) => {
  // `body.email` is already normalised: EmailField runs normalizeEmail before
  // validating, so what reaches the unique index is the canonical form.
  const body = await parseJson(req, RegisterBody)
  const ctx = clientContext(req)

  const passwordHash = await hashPassword(body.password)

  // The unique index is the arbiter, not a preceding SELECT. Read-then-write
  // leaves a window in which two concurrent signups both see the address as
  // free, and Postgres would then reject one of them as an unhandled error
  // instead of the 409 the client is owed.
  let user
  try {
    user = await db.user.create({
      data: { email: body.email, passwordHash, name: body.name },
      select: PUBLIC_USER_SELECT,
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === UNIQUE_VIOLATION) {
      throw conflict('An account with this email address already exists.')
    }
    throw e
  }

  const session = await issueUserSession(user.id, ctx)

  await recordAudit({
    action: 'user.registered',
    entityType: 'user',
    entityId: user.id,
    userId: user.id,
    after: { email: user.email, name: user.name },
    ...ctx,
  })

  return json(userSessionResponse(user, session), 201)
})
