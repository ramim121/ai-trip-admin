import type { Prisma } from '@/generated/prisma/client'
import { db } from '@/lib/db'
import { hashIp } from '@/server/auth/crypto'

/**
 * Append-only record of who did what.
 *
 * Callers pass a raw IP and this module pseudonymises it, so no route has to
 * remember to call `hashIp` and none can persist a raw address by forgetting.
 *
 * schema.prisma is explicit that `before`/`after` must never contain password
 * hashes or raw tokens. Nothing here can enforce that mechanically, so keep the
 * payloads to identifiers and reasons.
 */

/** Matches the truncation the refresh-token tables and guards.ts already apply. */
const MAX_USER_AGENT_LENGTH = 255

export interface AuditEvent {
  /** Past-tense verb, dotted: `user.registered`, `admin.login`. */
  action: string
  /** The kind of thing acted upon, e.g. `user`. */
  entityType: string
  entityId?: string | null
  /** Set when a staff member acted. */
  adminUserId?: string | null
  /** Set when a traveller acted, or when the action was taken against one. */
  userId?: string | null
  before?: Prisma.InputJsonValue
  after?: Prisma.InputJsonValue
  /** Raw address. Hashed here — never store it as-is. */
  ip?: string | null
  userAgent?: string | null
}

/**
 * Write one audit row.
 *
 * Failures are swallowed and logged rather than propagated. The tradeoff is
 * deliberate: the alternative is that a full disk or a lock timeout on
 * `audit_logs` turns a correct 401 into a 500, which both misinforms the client
 * and hands an attacker a way to change our responses by making the audit table
 * unwritable. Losing an audit row is bad; letting the audit table decide the
 * outcome of authentication is worse. The console line is what alerting should
 * watch, and it is loud on purpose.
 */
export async function recordAudit(event: AuditEvent): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId ?? null,
        adminUserId: event.adminUserId ?? null,
        userId: event.userId ?? null,
        before: event.before,
        after: event.after,
        ipHash: hashIp(event.ip),
        userAgent: event.userAgent ? event.userAgent.slice(0, MAX_USER_AGENT_LENGTH) : null,
      },
    })
  } catch (e) {
    const description = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    console.error(`[audit] FAILED to record "${event.action}": ${description}`)
  }
}
