import { Prisma } from '@/generated/prisma/client'
import { db } from '@/lib/db'
import { tooManyRequests } from './errors'

/**
 * A fixed-window rate limiter, counted in Postgres.
 *
 * The backstop for surfaces whose own metering can be reset by the caller. The
 * anonymous teaser is the motivating case: its quota lives on an
 * AnonymousVisitor row, and every signal that decides WHICH row applies —
 * cookie, device fingerprint, forwarded address — is supplied by the caller.
 * Tighten the row-picking as far as you like and there is still nothing
 * stopping a client from asking a thousand times; only a limit that is
 * *independent of the identity being metered* can answer that. So this counts
 * requests per edge address, and a caller who mints a fresh visitor row per
 * request discovers that minting rows does not mint AI spend.
 *
 * WHY POSTGRES AND NOT A MAP
 *
 * A `Map` in module scope is a limit per process. Two instances behind a load
 * balancer is two allowances; an autoscaler hands out another per new pod; a
 * serverless cold start resets the count to zero. A limit an attacker can
 * multiply by retrying until they land on a fresh process is not a limit, it is
 * a speed bump with good intentions. Shared durable state is the whole
 * requirement, and the database is shared durable state this request is already
 * using anyway.
 *
 * WHY FIXED WINDOWS
 *
 * One row, one statement, no timers and nothing held in memory. The known
 * weakness is the boundary: a caller who spends their whole allowance at the
 * end of one window and again at the start of the next issues 2×`limit` in
 * quick succession. That is said out loud rather than papered over, because for
 * a spend ceiling it is the right trade — the property we need is "bounded per
 * day", not "perfectly smooth per second", and a sliding window costs either a
 * row per request or state this has nowhere to keep.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not fail open. A database that cannot count is a database that cannot
 * serve the surrounding request either, so an error propagates instead of being
 * swallowed into an allow. Failing open here would make "make the database
 * unhappy" the cheapest way to switch the limiter off.
 */

/** Postgres unique violation, as Prisma reports it. */
const UNIQUE_VIOLATION = 'P2002'

/**
 * How long a closed window is kept before it may be pruned.
 *
 * Comfortably longer than the longest window in use, so a bucket is never
 * deleted while it is still counting. Past that, it is dead weight: the limiter
 * never reads a closed window, and keeping them would quietly turn this table
 * into a traffic archive of the people it exists to meter rather than to watch.
 */
const BUCKET_RETENTION_MS = 2 * 24 * 60 * 60 * 1_000

export interface RateLimitRule {
  /**
   * What is being limited. Namespace it by surface — `teaser:ip:<digest>` — so
   * two features cannot end up sharing one counter by accident.
   *
   * Must not contain a raw address, or anything else we would not put in a log.
   * Callers pass digests; see `hashIp()` in server/auth/crypto.ts.
   */
  key: string
  /** Hits permitted inside one window. */
  limit: number
  /** Window length. Boundaries are absolute wall-clock, not per caller. */
  windowSeconds: number
}

export interface RateLimitVerdict {
  allowed: boolean
  /** Hits recorded in this window, this one included. May exceed `limit`. */
  hits: number
  limit: number
  /** Seconds until this window rolls over and the allowance returns. */
  retryAfterSeconds: number
}

/**
 * Record one hit and report whether it is within the limit.
 *
 * The counter is incremented BEFORE the caller does the work being limited, and
 * a refused hit still counts. Both halves matter. Incrementing afterwards would
 * let every concurrent request pass the check before any of them recorded
 * itself — the same read-then-write race `consumePrompt` exists to prevent —
 * and not counting refusals would let somebody who keeps hammering hold their
 * window open at exactly the limit indefinitely.
 *
 * The upsert is the atomic part. Postgres resolves `INSERT … ON CONFLICT DO
 * UPDATE` against the `(bucketKey, windowStart)` unique index under a row lock,
 * so simultaneous callers increment one row instead of each inserting their
 * own and every one of them reading back `1`. The P2002 fallback covers a
 * driver that splits the upsert into find-then-insert: the loser of that race
 * retries as a plain increment against the winner's row, which is the same
 * answer one statement later.
 */
export async function consumeRateLimit(
  rule: RateLimitRule,
  now: Date = new Date()
): Promise<RateLimitVerdict> {
  const windowMs = rule.windowSeconds * 1_000
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs)

  const hits = await increment(rule.key, windowStart)

  // Opening a new window is the natural moment to take the rubbish out: it
  // happens at most once per key per window, so the sweep can never run more
  // often than the limiter itself permits requests through.
  if (hits === 1) await pruneRateLimitBuckets(new Date(now.getTime() - BUCKET_RETENTION_MS))

  const elapsedMs = now.getTime() - windowStart.getTime()

  return {
    allowed: hits <= rule.limit,
    hits,
    limit: rule.limit,
    retryAfterSeconds: Math.max(1, Math.ceil((windowMs - elapsedMs) / 1_000)),
  }
}

async function increment(bucketKey: string, windowStart: Date): Promise<number> {
  try {
    const bucket = await db.rateLimitBucket.upsert({
      where: { bucketKey_windowStart: { bucketKey, windowStart } },
      create: { bucketKey, windowStart, hits: 1 },
      update: { hits: { increment: 1 } },
      select: { hits: true },
    })

    return bucket.hits
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === UNIQUE_VIOLATION) {
      const bucket = await db.rateLimitBucket.update({
        where: { bucketKey_windowStart: { bucketKey, windowStart } },
        data: { hits: { increment: 1 } },
        select: { hits: true },
      })

      return bucket.hits
    }

    throw e
  }
}

/**
 * Record one hit and throw 429 when it is over the limit.
 *
 * The message is the caller's, because "you have asked for too many previews"
 * and "the site has generated every preview it will today" are different facts
 * and a visitor is owed the one that actually applies to them.
 */
export async function enforceRateLimit(rule: RateLimitRule, message: string): Promise<void> {
  const verdict = await consumeRateLimit(rule)
  if (verdict.allowed) return

  throw tooManyRequests(message)
}

/**
 * Delete windows that closed long ago.
 *
 * Self-cleaning on purpose: a table that only grows is a table somebody has to
 * remember to sweep, and nobody does. Exported so a scheduled job can call it
 * as well, and so the retention rule can be asserted directly in a test instead
 * of being inferred from its call site.
 */
export async function pruneRateLimitBuckets(olderThan: Date): Promise<number> {
  const removed = await db.rateLimitBucket.deleteMany({ where: { windowStart: { lt: olderThan } } })
  return removed.count
}
