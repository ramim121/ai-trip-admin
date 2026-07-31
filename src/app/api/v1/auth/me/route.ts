import type { NextRequest } from 'next/server'
import { UserStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { unauthorized } from '@/server/http/errors'
import { requireUser } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { PUBLIC_USER_SELECT, toPublicUser } from '@/server/modules/auth/service'

/**
 * GET /api/v1/auth/me — the signed-in traveller.
 *
 * The profile is read from the database rather than reconstructed from the
 * token. An access token carries only `sub` and `sid` by design: putting a name
 * or an avatar in it would mean serving a stale copy for the rest of that
 * token's life, and would grow a credential that travels on every request.
 *
 * Status is re-checked even though the signature verified. Access tokens are
 * not revocable, so an account suspended thirty seconds ago still holds a valid
 * one; this is where that stops mattering for this endpoint.
 *
 * A missing or non-active account answers 401, not 404. What is being refused
 * is the token, not a resource — and a 404 would tell whoever holds the token
 * that the account it names has been deleted.
 */
export const GET = route(async (req: NextRequest) => {
  const claims = await requireUser(req)

  const user = await db.user.findUnique({
    where: { id: claims.userId },
    select: { ...PUBLIC_USER_SELECT, status: true },
  })

  if (user === null || user.status !== UserStatus.ACTIVE) throw unauthorized()

  return json(toPublicUser(user))
})
