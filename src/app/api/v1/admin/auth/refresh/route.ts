import type { NextRequest } from 'next/server'
import { rotateAdminSession } from '@/server/auth/tokens'
import { clientContext } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { RefreshBody } from '@/server/modules/auth/schema'
import { invalidRefreshToken, tokenPair } from '@/server/modules/auth/service'

/**
 * POST /api/v1/admin/auth/refresh — rotate a staff refresh token.
 *
 * This is where staff revocation actually bites. Access tokens are never
 * checked against the database, so disabling or demoting an admin takes effect
 * at the next refresh: `rotateAdminSession` re-reads the row, refuses anything
 * no longer ACTIVE, and mints the successor with the role the database holds
 * now rather than the one the old token carried.
 *
 * That makes the access-token TTL the real exposure window for a revoked
 * admin — one more reason to keep AUTH_ACCESS_TTL_SECONDS short.
 */
export const POST = route(async (req: NextRequest) => {
  const body = await parseJson(req, RefreshBody)

  const session = await rotateAdminSession(body.refreshToken, clientContext(req))
  if (session === null) throw invalidRefreshToken()

  return json(tokenPair(session))
})
