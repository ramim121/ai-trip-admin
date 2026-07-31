import type { NextRequest } from 'next/server'
import { AdminStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { unauthorized } from '@/server/http/errors'
import { requireAdmin } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { PUBLIC_ADMIN_SELECT, toPublicAdmin } from '@/server/modules/auth/service'

/**
 * GET /api/v1/admin/auth/me — the signed-in staff member.
 *
 * `requireAdmin` is called with no role list: every staff member may read their
 * own record, whatever their role.
 *
 * The role returned is the one in the database, not the one in the token. Admin
 * consoles use this endpoint to decide which navigation to render, and showing
 * a demoted admin the controls their stale token still claims would produce a
 * UI full of actions the server is about to refuse.
 *
 * Status is re-checked for the same reason as on the traveller endpoint: a
 * signature that verifies proves only that the token was minted, not that the
 * account behind it is still allowed in.
 */
export const GET = route(async (req: NextRequest) => {
  const claims = await requireAdmin(req)

  const admin = await db.adminUser.findUnique({
    where: { id: claims.adminUserId },
    select: { ...PUBLIC_ADMIN_SELECT, status: true },
  })

  if (admin === null || admin.status !== AdminStatus.ACTIVE) throw unauthorized()

  return json(toPublicAdmin(admin))
})
