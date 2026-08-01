'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { AdminStatus } from '@/generated/prisma/enums'
import { db } from '@/lib/db'
import { env } from '@/lib/env'
import { recordAudit } from '@/server/audit/log'
import { fakePasswordVerification, verifyPassword } from '@/server/auth/crypto'
import { issueAdminSession, revokeAdminSession } from '@/server/auth/tokens'
import { enforceRateLimit } from '@/server/http/rate-limit'
import { normalizeEmail } from '@/server/auth/email'
import { PUBLIC_ADMIN_SELECT } from '@/server/modules/auth/service'
import { ADMIN_CONSOLE_COOKIE } from '../(admin)/_lib/console-session'

/**
 * Sign-in for the console.
 *
 * The console is server-rendered from the database rather than through the API,
 * so it needs a credential in a cookie rather than a bearer header. What it must
 * NOT become is a second, weaker way in: this performs the same checks in the
 * same order as POST /api/v1/admin/auth/login — decoy verification on the
 * unknown address, one indistinguishable refusal, an audit row on every failure
 * — so neither door tells an attacker more than the other.
 *
 * The refresh token is issued and immediately revoked rather than handed to the
 * browser. A server-rendered console has no client-side loop to refresh with,
 * and parking a 30-day credential in a browser to save a staff member re-typing
 * a password is a poor trade on the screens that show revenue. Staff sign in
 * again when the access token lapses.
 */

export interface LoginState {
  error: string | null
}

export async function signIn(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = normalizeEmail(String(formData.get('email') ?? ''))
  const password = String(formData.get('password') ?? '')

  if (email === '' || password === '') {
    return { error: 'Enter your email and password.' }
  }

  // Keyed on the address being attempted, so one account cannot be ground
  // through a password list from here while the API's own limiter watches a
  // different door.
  try {
    await enforceRateLimit(
      { key: `admin:console:login:${email}`, limit: 10, windowSeconds: 900 },
      'Too many sign-in attempts.'
    )
  } catch {
    return { error: 'Too many sign-in attempts. Wait a few minutes and try again.' }
  }

  const admin = await db.adminUser.findUnique({
    where: { email },
    select: { ...PUBLIC_ADMIN_SELECT, passwordHash: true, status: true },
  })

  // One wording for every failure below. An attacker learns whether they have
  // found a real staff address only if we tell them, and staff addresses are
  // the ones most worth enumerating before a targeted phish.
  const refusal: LoginState = { error: 'Those credentials did not match.' }

  if (admin === null) {
    // Spend the CPU the real path would, so response time does not answer the
    // question the message refuses to.
    await fakePasswordVerification()
    await recordAudit({
      action: 'admin.console_login_failed',
      entityType: 'admin_user',
      after: { email, reason: 'unknown_email' },
    })
    return refusal
  }

  if (!(await verifyPassword(admin.passwordHash, password))) {
    await recordAudit({
      action: 'admin.console_login_failed',
      entityType: 'admin_user',
      entityId: admin.id,
      adminUserId: admin.id,
      after: { email: admin.email, reason: 'bad_password' },
    })
    return refusal
  }

  if (admin.status !== AdminStatus.ACTIVE) {
    await recordAudit({
      action: 'admin.console_login_failed',
      entityType: 'admin_user',
      entityId: admin.id,
      adminUserId: admin.id,
      after: { email: admin.email, reason: 'not_active' },
    })
    return refusal
  }

  const session = await issueAdminSession(admin.id, admin.role, {})
  const config = env()

  const jar = await cookies()
  jar.set(ADMIN_CONSOLE_COOKIE, session.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    path: '/',
    maxAge: config.AUTH_ACCESS_TTL_SECONDS,
  })

  // Issued by `issueAdminSession` but never given to the browser, so it is dead
  // weight in the table if left alive.
  await revokeAdminSession(session.refreshToken)

  await recordAudit({
    action: 'admin.console_login',
    entityType: 'admin_user',
    entityId: admin.id,
    adminUserId: admin.id,
  })

  redirect('/')
}

export async function signOut(): Promise<void> {
  const jar = await cookies()
  jar.delete(ADMIN_CONSOLE_COOKIE)
  redirect('/login')
}
