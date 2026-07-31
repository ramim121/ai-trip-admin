import type { NextRequest } from 'next/server'
import { AdminStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { recordAudit } from '@/server/audit/log'
import { fakePasswordVerification, verifyPassword } from '@/server/auth/crypto'
import { issueAdminSession } from '@/server/auth/tokens'
import { clientContext } from '@/server/http/guards'
import { json, route } from '@/server/http/handler'
import { parseJson } from '@/server/http/validate'
import { LoginBody } from '@/server/modules/auth/schema'
import {
  adminSessionResponse,
  invalidCredentials,
  PUBLIC_ADMIN_SELECT,
} from '@/server/modules/auth/service'

/**
 * POST /api/v1/admin/auth/login — staff sign-in.
 *
 * Structurally identical to the traveller login, and deliberately so: the same
 * ordering of checks, the same single refusal, the same decoy verification on
 * the unknown-address branch. Staff addresses are the ones most worth
 * enumerating — knowing which addresses are administrators is the first step of
 * a targeted phish — so this endpoint gets no weaker treatment than the public
 * one.
 *
 * The two audiences remain separate tables signed with separate secrets. A
 * traveller cannot become staff through any request they are able to make,
 * because there is no flag to flip: privilege lives in a row they cannot reach.
 *
 * `admin.login_failed` is recorded in addition to the events the brief lists.
 * Repeated failures against a staff account are the signal most worth alerting
 * on, and an audit trail that shows only successes cannot show an attempt.
 *
 * TODO(phase-5): rate limit, and require a second factor here before this sees
 * production traffic.
 */
export const POST = route(async (req: NextRequest) => {
  const body = await parseJson(req, LoginBody)
  const ctx = clientContext(req)

  const admin = await db.adminUser.findUnique({
    where: { email: body.email },
    select: { ...PUBLIC_ADMIN_SELECT, passwordHash: true, status: true },
  })

  if (admin === null) {
    await fakePasswordVerification()
    await recordAudit({
      action: 'admin.login_failed',
      entityType: 'admin_user',
      after: { email: body.email, reason: 'unknown_email' },
      ...ctx,
    })
    throw invalidCredentials()
  }

  const passwordMatches = await verifyPassword(admin.passwordHash, body.password)

  if (!passwordMatches) {
    await recordAudit({
      action: 'admin.login_failed',
      entityType: 'admin_user',
      entityId: admin.id,
      adminUserId: admin.id,
      after: { email: admin.email, reason: 'bad_password' },
      ...ctx,
    })
    throw invalidCredentials()
  }

  // A disabled admin is refused here, and `rotateAdminSession` refuses one
  // again on every refresh. Disabling someone has to stop them at both doors,
  // or an already-open session would outlive their access.
  if (admin.status !== AdminStatus.ACTIVE) {
    await recordAudit({
      action: 'admin.login_failed',
      entityType: 'admin_user',
      entityId: admin.id,
      adminUserId: admin.id,
      after: { email: admin.email, reason: `account_${admin.status.toLowerCase()}` },
      ...ctx,
    })
    throw invalidCredentials()
  }

  await db.adminUser.update({
    where: { id: admin.id },
    data: { lastLoginAt: new Date() },
    select: { id: true },
  })

  // The role comes from the row just verified, so a demotion applied a moment
  // ago is already reflected in the token this login mints.
  const session = await issueAdminSession(admin.id, admin.role, ctx)

  await recordAudit({
    action: 'admin.login',
    entityType: 'admin_user',
    entityId: admin.id,
    adminUserId: admin.id,
    after: { email: admin.email, role: admin.role },
    ...ctx,
  })

  return json(adminSessionResponse(admin, session))
})
