import { cookies } from 'next/headers'
import { AdminRole } from '@/generated/prisma/enums'
import { verifyAccessToken, type AdminAccessClaims } from '@/server/auth/jwt'

/**
 * Who is looking at the admin console.
 *
 * The console is server-rendered straight from the database — it lives in the
 * repository that owns Postgres — so every page here is a read the API's
 * bearer-token guards never see. That makes this file the only thing between an
 * unauthenticated browser and the payments table, and it is written to fail
 * closed: no cookie, an expired token, a token signed for the traveller
 * audience, or anything malformed all resolve to `null`, and every page and
 * every action treats `null` as "show nothing, do nothing".
 *
 * The credential is the same admin access token POST /api/v1/admin/auth/login
 * issues, carried in an httpOnly cookie rather than an Authorization header
 * because a server-rendered page has nowhere to put a header. It is verified
 * with `verifyAccessToken(token, 'admin')`, so the audience separation that
 * protects the API protects the console too: a traveller token is not merely
 * insufficient here, it is unverifiable.
 *
 * There is no sign-in form yet — that arrives with the console's own auth
 * phase. Until then the console is reachable only by someone who can place a
 * valid admin token in this cookie, which is the right posture for an
 * unfinished screen: unusable, not unguarded.
 */

/** The httpOnly cookie carrying an admin access token. */
export const ADMIN_CONSOLE_COOKIE = 'bb_admin_console'

/** Claims for the staff member viewing, or null if there is not one. */
export async function readConsoleAdmin(): Promise<AdminAccessClaims | null> {
  const jar = await cookies()
  const token = jar.get(ADMIN_CONSOLE_COOKIE)?.value
  if (!token) return null

  return verifyAccessToken(token, 'admin')
}

/**
 * Claims, if the viewer holds one of `allowedRoles`.
 *
 * SUPER_ADMIN always satisfies the list, matching `requireAdmin` in the API —
 * two different rules for the same role would be a bug waiting on whichever one
 * somebody happens to remember.
 *
 * Note what this checks: the *token*, not the database. An admin disabled since
 * their token was minted keeps console access until it expires, exactly as they
 * keep API access. Revocation lives at the refresh layer, and the exposure is
 * one access-token TTL either way.
 */
export async function readConsoleAdminWithRole(
  allowedRoles: readonly AdminRole[]
): Promise<AdminAccessClaims | null> {
  const claims = await readConsoleAdmin()
  if (claims === null) return null

  if (claims.role === AdminRole.SUPER_ADMIN) return claims
  return allowedRoles.includes(claims.role) ? claims : null
}

/**
 * Roles that may read the commerce screens.
 *
 * OPS runs quotes, bookings and payments, so these are their screens. CONTENT
 * and SUPPORT have no business reading revenue, and the console is not the
 * place for that to become negotiable.
 */
export const COMMERCE_READ_ROLES: readonly AdminRole[] = [AdminRole.OPS]

/**
 * Roles that may change what we charge.
 *
 * SUPER_ADMIN only, expressed by an empty list plus the implicit SUPER_ADMIN
 * pass in `readConsoleAdminWithRole`. Editing a plan changes the price of every
 * future purchase of it, which should need the account that can also hand that
 * power to somebody else.
 */
export const COMMERCE_WRITE_ROLES: readonly AdminRole[] = []

/**
 * Roles that may price and send a quotation.
 *
 * OPS, and deliberately NOT `COMMERCE_WRITE_ROLES` — the two look adjacent and
 * are different in kind. Editing a plan sets the price of every future purchase
 * of it by everybody, which is why that list is SUPER_ADMIN only. Pricing a
 * quote sets the price of ONE bespoke trip for ONE traveller who asked for it,
 * it is attributed to its author on the revision row, and a mistake is corrected
 * by sending a new version rather than by a migration.
 *
 * Reusing the stricter list here would have been the cautious-looking choice and
 * the wrong one: quoting is the whole of OPS's daily work, so a console needing
 * a SUPER_ADMIN for every quote is a console nobody can use, and the predictable
 * result is one shared SUPER_ADMIN login for the whole office — strictly worse
 * for both access control and the audit trail than granting OPS the thing their
 * job is made of.
 */
export const QUOTE_WRITE_ROLES: readonly AdminRole[] = [AdminRole.OPS]

/**
 * Roles that may create and edit promo codes.
 *
 * OPS, on the same reasoning as quoting and again NOT `COMMERCE_WRITE_ROLES`.
 * The distinction is blast radius, and for a coupon it is bounded BY THE ROW
 * ITSELF: `maxRedemptions` caps how many times it can ever be used,
 * `maxPerUser` caps it per account, `maxDiscountBdt` caps what a percentage can
 * take off, and the window caps how long it lives. A mistake costs at most what
 * those numbers allow, and deactivating stops it immediately.
 *
 * Repricing a plan has none of those brakes: it changes what every future
 * purchase costs, for everybody, until somebody notices. That is the difference
 * that puts the two in different lists rather than the fact that both involve
 * money.
 *
 * A CODE IS STILL NEVER DELETED, only deactivated — see the actions. The audit
 * trail and the redemption rows are what somebody will need when a traveller
 * says a discount was promised.
 */
export const PROMO_WRITE_ROLES: readonly AdminRole[] = [AdminRole.OPS]

/**
 * Roles that may read the catalog.
 *
 * Everyone on staff. This is the inventory we advertise publicly and the only
 * inventory the planner may recommend, so "what do we actually sell in Cox's
 * Bazar" is a question OPS needs while booking and SUPPORT needs while replying
 * to a traveller. Nothing here is confidential — the same rows are served
 * unauthenticated from GET /api/v1/destinations.
 */
export const CATALOG_READ_ROLES: readonly AdminRole[] = [
  AdminRole.CONTENT,
  AdminRole.OPS,
  AdminRole.SUPPORT,
]

/**
 * Roles that may change the catalog.
 *
 * CONTENT, plus the implicit SUPER_ADMIN pass. What is written here decides what
 * the AI recommends and what ops is then asked to deliver: a wrong price or a
 * wrong opening time surfaces as a traveller standing outside a closed gate. It
 * is the curators' screen and nobody else's.
 */
export const CATALOG_WRITE_ROLES: readonly AdminRole[] = [AdminRole.CONTENT]
