import type { NextRequest } from 'next/server'
import { revokeAdminSession } from '@/server/auth/tokens'
import { noContent, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { RefreshBody } from '@/server/modules/auth/schema'

/**
 * POST /api/v1/admin/auth/logout — end one staff session.
 *
 * Always 204, for the same reason the traveller logout is: an unknown token
 * must not answer differently from a live one, or this becomes a way to test
 * whether a captured staff token still works.
 *
 * Revocation is scoped to the presented token and touches the admin tables
 * only — a traveller refresh token posted here matches nothing and silently
 * changes nothing, because the two audiences share no storage.
 */
export const POST = route(async (req: NextRequest) => {
  const body = await parseJson(req, RefreshBody)

  await revokeAdminSession(body.refreshToken)

  return noContent()
})
