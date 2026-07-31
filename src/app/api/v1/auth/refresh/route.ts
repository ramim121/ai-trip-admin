import type { NextRequest } from 'next/server'
import { rotateUserSession } from '@/server/auth/tokens'
import { clientContext } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { RefreshBody } from '@/server/modules/auth/schema'
import { invalidRefreshToken, tokenPair } from '@/server/modules/auth/service'

/**
 * POST /api/v1/auth/refresh — trade a refresh token for its successor.
 *
 * No access token is required, and requiring one would defeat the purpose: the
 * refresh token *is* the credential being presented, and the whole reason to
 * present it is that the access token has expired.
 *
 * `rotateUserSession` returns null for every refusal — unknown token, expired,
 * already rotated, account suspended, lost race — and this handler keeps them
 * indistinguishable. Reporting "already used" separately would confirm to
 * whoever stole a token that it had been genuine.
 *
 * Note what a replay costs: presenting a token that was already rotated is
 * exactly what reuse detection looks for, and it revokes the entire token
 * family, ending the session on every device.
 */
export const POST = route(async (req: NextRequest) => {
  const body = await parseJson(req, RefreshBody)

  const session = await rotateUserSession(body.refreshToken, clientContext(req))
  if (session === null) throw invalidRefreshToken()

  return json(tokenPair(session))
})
