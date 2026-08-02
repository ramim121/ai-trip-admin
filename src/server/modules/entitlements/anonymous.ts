import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { Prisma } from '@/generated/prisma/client'
import { db } from '@/lib/db'
import { env } from '@/lib/env'
import { hashFingerprint, hashIp } from '@/server/auth/crypto'
import { readCachedSetting } from '@/server/settings/read'

/**
 * Who an anonymous visitor is, and how their single prompt is spent.
 *
 * Identity here is the union of three weak signals — a signed cookie we mint, a
 * salted hash of the IP, a salted hash of a device fingerprint — and a hit on
 * ANY ONE of them is the same visitor. That is the whole design. Each signal
 * alone is trivially defeated: cookies get cleared, incognito windows produce a
 * fresh fingerprint, and phones change IP by walking between cells. Requiring
 * all three to match would mean the quota resets on a cookie clear; requiring
 * any one to match means it does not.
 *
 * The cost is over-matching, and it is a deliberate, documented cost. Two
 * genuine strangers behind one office NAT are one visitor to this table. We
 * would rather occasionally ask a second person to sign in than hand unlimited
 * free AI to anybody who knows what Ctrl-Shift-N does.
 *
 * Raw addresses and raw fingerprints never reach the database. Only digests are
 * stored, so this table cannot be turned into a location log for the very
 * people it is meant to meter.
 */

/** Name of the signed cookie carrying the visitor id. */
export const VISITOR_COOKIE_NAME = 'bb_visitor'

/** One year. Short-lived would make the cookie a quota reset on a timer. */
export const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

/**
 * The product rule: one AI prompt for an anonymous visitor, ever.
 *
 * Ops can move this from the console through `ai.teaser.promptLimit` — see
 * `anonymousPromptLimit()` — but this constant is what applies when that row is
 * missing, unreadable or nonsense, so the limit never fails open.
 */
export const ANONYMOUS_PROMPT_LIMIT = 1

/** The settings key ops edits to change the limit without a deploy. */
export const ANONYMOUS_PROMPT_LIMIT_SETTING_KEY = 'ai.teaser.promptLimit'

/**
 * A ceiling on what that row may say.
 *
 * The setting is a dial for turning the teaser off in an incident (`0`) or
 * loosening it slightly during a campaign — not a way to make anonymous AI
 * free. A fat-fingered `1000` in the console should not hand out a thousand
 * free generations per visitor.
 */
const MAX_CONFIGURABLE_PROMPT_LIMIT = 10

const PromptLimitSchema = z.number().int().min(0).max(MAX_CONFIGURABLE_PROMPT_LIMIT)

/** Longest cookie value we will even look at, before verifying its signature. */
const MAX_VISITOR_COOKIE_LENGTH = 256

/** Bounds on the id inside the cookie. A uuid is 36 characters. */
const MIN_COOKIE_ID_LENGTH = 16
const MAX_COOKIE_ID_LENGTH = 64

export interface VisitorSignals {
  /** The id read out of the signed cookie, or null when there is not one. */
  cookieId?: string | null
  /** Raw client address. Hashed here — never stored as-is. */
  ip?: string | null
  /** Raw device fingerprint from the browser. Hashed here, same as the IP. */
  fingerprint?: string | null
}

export interface IdentifiedVisitor {
  id: string
  /**
   * The canonical cookie id for this visitor, which is NOT always the one that
   * arrived. When someone is recognised by IP or fingerprint after clearing
   * their cookies, this is the original row's id, and the caller should re-set
   * the cookie to it — pulling the browser back onto the identity it tried to
   * shed.
   */
  cookieId: string
  promptsUsed: number
  /** Set once this visitor registered; their teaser session belongs to that account. */
  convertedUserId: string | null
  /** False when an existing row matched — the interesting case for abuse work. */
  created: boolean
}

const VISITOR_SELECT = {
  id: true,
  cookieId: true,
  promptsUsed: true,
  convertedUserId: true,
} satisfies Prisma.AnonymousVisitorSelect

/** Postgres unique violation, as Prisma reports it. */
const UNIQUE_VIOLATION = 'P2002'

// ─────────────────────────────────────────────────────────────────────────────
// The cookie
//
// Signed, not encrypted. There is nothing secret in a visitor id — it names a
// row holding two digests and a small integer. What the signature buys is that
// a visitor cannot *choose* their id: without it, anyone could type a fresh
// uuid into their cookie jar and mint themselves an unlimited supply of first
// visits, leaving the other two signals to do all the work.
// ─────────────────────────────────────────────────────────────────────────────

function signature(cookieId: string): string {
  // Domain-labelled so this HMAC can never be confused with another use of the
  // same secret.
  return createHmac('sha256', env().AUTH_USER_SECRET)
    .update(`visitor:${cookieId}`)
    .digest('base64url')
}

/** A fresh visitor id. Unguessable is not required; unique is. */
export function mintVisitorCookieId(): string {
  return randomUUID()
}

/** `<id>.<signature>` — what goes into the Set-Cookie header. */
export function signVisitorCookie(cookieId: string): string {
  return `${cookieId}.${signature(cookieId)}`
}

/**
 * Recover the visitor id from a cookie value, or null if it was not ours.
 *
 * Every rejection is silent and identical. A tampered cookie is treated exactly
 * like an absent one — the visitor is simply new — because the alternative is
 * an endpoint that tells an attacker whether their forgery was close.
 */
export function readVisitorCookie(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_VISITOR_COOKIE_LENGTH) return null

  const separator = raw.lastIndexOf('.')
  if (separator <= 0 || separator === raw.length - 1) return null

  const cookieId = raw.slice(0, separator)
  if (cookieId.length < MIN_COOKIE_ID_LENGTH || cookieId.length > MAX_COOKIE_ID_LENGTH) return null

  const presented = Buffer.from(raw.slice(separator + 1))
  const expected = Buffer.from(signature(cookieId))

  // timingSafeEqual throws on a length mismatch, and both lengths are public
  // (base64url SHA-256 either way), so comparing them first leaks nothing.
  if (presented.length !== expected.length) return null
  if (!timingSafeEqual(presented, expected)) return null

  return cookieId
}

// ─────────────────────────────────────────────────────────────────────────────
// Identification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A digest standing in for a signal we did not receive.
 *
 * `ipHash` and `fingerprintHash` are non-null columns, so an absent signal has
 * to be stored as *something*. It must not be a constant: a shared placeholder
 * would make every visitor with no fingerprint match every other one, so the
 * first person to use the teaser from a script would exhaust the quota for all
 * of them. Random per row means an absent signal matches nothing but itself,
 * which is exactly what "we do not know" should mean.
 */
function unknownSignal(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Find the visitor these signals belong to, creating one if they are new.
 *
 * Returns null for an UNIDENTIFIABLE caller — one that presented no signal at
 * all. Callers must refuse those, not invent an identity for them.
 *
 * Matching is `OR` across whichever signals we actually have. Signals we do not
 * have are left out of the query rather than matched against null, because "no
 * fingerprint" must not find every other visitor who also sent none.
 *
 * When several rows match, the one that has spent the most prompts wins and the
 * oldest breaks the tie. That ordering is the anti-abuse choice: if a device
 * that has already had its teaser shares an IP with a fresh cookie, the spent
 * identity is the one we adopt. Reversing it would make "open an incognito
 * window" a working bypass whenever it created a second row first.
 *
 * ZERO signals used to mean "a brand-new visitor", and that was the bug. All
 * three signals are chosen by the caller within the same request — the cookie
 * can simply be omitted, the fingerprint is a plain body field, and before
 * `TRUSTED_PROXY_HOPS` the IP was a header they wrote. A request carrying none
 * of them matched nothing, fell through to `create` with `promptsUsed: 0`, and
 * walked away with another free preview. No forgery was needed: a `curl` loop
 * sending no cookie against a deployment with no trusted edge produced exactly
 * that, once per request, indefinitely.
 *
 * Refusing instead puts this module back in agreement with the rule service.ts
 * already states for `canPrompt` — an unidentifiable caller is the one case
 * where handing out a free generation is definitely wrong. Minting a row *is*
 * handing one out, so the two cannot be allowed to disagree about it.
 */
/**
 * Look a visitor up by cookie, without creating one and without touching them.
 *
 * `identifyVisitor` is the wrong tool for a read: it mints a row when nothing
 * matches, which is exactly right when a quota is about to be spent and exactly
 * wrong on a GET. A request that only wants to know "has this browser voted
 * already" must not leave a visitor row behind, and must not stamp `lastSeenAt`
 * either — a page view is not activity, and forging it here would corrupt the
 * one signal the abuse queries read.
 *
 * Cookie only, deliberately. The IP and fingerprint arms of the union exist to
 * re-find somebody who cleared their cookies, which is an anti-bypass measure
 * worth its false positives when a quota is at stake. On a read it would mean
 * showing one visitor another visitor's answer because they share an office
 * router, so this arm is the narrow one.
 */
export async function findVisitorByCookie(
  cookieId: string | null
): Promise<{ id: string; cookieId: string } | null> {
  const trimmed = cookieId?.trim()
  if (!trimmed) return null

  return db.anonymousVisitor.findUnique({
    where: { cookieId: trimmed },
    select: { id: true, cookieId: true },
  })
}

export async function identifyVisitor(signals: VisitorSignals): Promise<IdentifiedVisitor | null> {
  const cookieId = signals.cookieId?.trim() || null
  const ipHash = hashIp(signals.ip)
  const fingerprintHash = hashFingerprint(signals.fingerprint)

  const matchers: Prisma.AnonymousVisitorWhereInput[] = []
  if (cookieId) matchers.push({ cookieId })
  if (ipHash) matchers.push({ ipHash })
  if (fingerprintHash) matchers.push({ fingerprintHash })

  // Nothing to match on, and therefore nothing to create either.
  if (matchers.length === 0) return null

  const now = new Date()

  const existing = await db.anonymousVisitor.findFirst({
    where: { OR: matchers },
    orderBy: [{ promptsUsed: 'desc' }, { firstSeenAt: 'asc' }],
    select: VISITOR_SELECT,
  })

  if (existing !== null) {
    // Written explicitly rather than through @updatedAt, so touching an
    // unrelated column can never forge activity on this row.
    await db.anonymousVisitor.update({
      where: { id: existing.id },
      data: { lastSeenAt: now },
      select: { id: true },
    })

    return { ...existing, created: false }
  }

  const newCookieId = cookieId ?? mintVisitorCookieId()

  try {
    const created = await db.anonymousVisitor.create({
      data: {
        cookieId: newCookieId,
        ipHash: ipHash ?? unknownSignal(),
        fingerprintHash: fingerprintHash ?? unknownSignal(),
        lastSeenAt: now,
      },
      select: VISITOR_SELECT,
    })

    return { ...created, created: true }
  } catch (e) {
    // Two requests from one brand-new visitor can both miss the SELECT and both
    // try to insert. The unique index on cookieId settles it; the loser reads
    // the winner's row rather than failing, since both requests are the same
    // person and both must land on the same quota.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === UNIQUE_VIOLATION) {
      const raced = await db.anonymousVisitor.findUnique({
        where: { cookieId: newCookieId },
        select: VISITOR_SELECT,
      })
      if (raced !== null) return { ...raced, created: false }
    }
    throw e
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The quota
// ─────────────────────────────────────────────────────────────────────────────

/** The limit in force: the settings row if it is sane, the constant otherwise. */
export async function anonymousPromptLimit(): Promise<number> {
  const configured = await readCachedSetting(ANONYMOUS_PROMPT_LIMIT_SETTING_KEY, PromptLimitSchema)
  return configured ?? ANONYMOUS_PROMPT_LIMIT
}

/**
 * Spend one prompt, atomically. Returns false when there was none left.
 *
 * This is the only place the anonymous limit is genuinely enforced, and the
 * shape of the query is the reason. The predicate `promptsUsed < limit` and the
 * `increment` are one `UPDATE ... WHERE promptsUsed < $limit` statement, so
 * Postgres takes a row lock and re-evaluates the predicate against the
 * committed row. Two requests arriving together therefore see 0 and then 1, and
 * exactly one of them comes back with a count of 1.
 *
 * Read the row, compare in JavaScript, then write it back, and both requests
 * read 0, both decide they may proceed, and both write 1 — the visitor gets two
 * free generations for the price of opening two tabs. The check in
 * `canPrompt()` is that read: it exists to produce a good error message, and it
 * is advisory. This function is the enforcement.
 */
export async function consumePrompt(visitorId: string, limit?: number): Promise<boolean> {
  const ceiling = limit ?? (await anonymousPromptLimit())

  const claimed = await db.anonymousVisitor.updateMany({
    where: { id: visitorId, promptsUsed: { lt: ceiling } },
    data: { promptsUsed: { increment: 1 }, lastSeenAt: new Date() },
  })

  return claimed.count === 1
}

/**
 * Hand a spent prompt back after a generation failed.
 *
 * The quota is claimed before the model is called, because claiming it
 * afterwards is the race this module exists to prevent. The consequence is that
 * a provider outage would otherwise burn a visitor's only prompt on a reply
 * they never received, with no way to appeal. The refund is guarded on
 * `promptsUsed > 0` so it cannot push the counter negative, and it grants
 * nothing: the caller reaches it only when no teaser was produced.
 */
export async function refundPrompt(visitorId: string): Promise<void> {
  await db.anonymousVisitor.updateMany({
    where: { id: visitorId, promptsUsed: { gt: 0 } },
    data: { promptsUsed: { decrement: 1 } },
  })
}

/**
 * Link a visitor to the account they just created.
 *
 * Guarded on `convertedUserId: null`, so a visitor is claimed once and stays
 * claimed. Without the guard, replaying this call with a second account id
 * would let one teaser session be adopted by any number of accounts, and "which
 * visitor became which customer" would have no answer.
 *
 * Returns false when the visitor is unknown or already converted — both are
 * "nothing to do", and neither is an error a signup should fail on.
 */
export async function convertVisitor(visitorId: string, userId: string): Promise<boolean> {
  const linked = await db.anonymousVisitor.updateMany({
    where: { id: visitorId, convertedUserId: null },
    data: { convertedUserId: userId },
  })

  return linked.count === 1
}
