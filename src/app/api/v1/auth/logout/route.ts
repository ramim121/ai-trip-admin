import type { NextRequest } from 'next/server'
import { revokeUserSession } from '@/server/auth/tokens'
import { noContent, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { RefreshBody } from '@/server/modules/auth/schema'

/**
 * POST /api/v1/auth/logout — end one session.
 *
 * Unconditionally 204, including for a token that never existed or was revoked
 * an hour ago. Logging out cannot meaningfully fail from the caller's point of
 * view, and answering 404 for an unknown token would turn this into a free
 * oracle for testing whether a captured token is still live.
 *
 * Only the presented token's row is revoked, so signing out on a phone leaves a
 * laptop signed in. Ending every session at once is what a password reset does.
 *
 * The matching access token keeps working until it expires — at most
 * AUTH_ACCESS_TTL_SECONDS. That is inherent to stateless access tokens and is
 * why that TTL is short; the alternative is a database read on every request.
 */
export const POST = route(async (req: NextRequest) => {
  const body = await parseJson(req, RefreshBody)

  await revokeUserSession(body.refreshToken)

  return noContent()
})
