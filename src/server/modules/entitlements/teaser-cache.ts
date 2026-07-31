import { createHash } from 'node:crypto'
import { Prisma } from '@/generated/prisma/client'
import { db } from '@/lib/db'
import {
  TeaserResponseSchema,
  teaserCacheKey,
  type TeaserQuestionnaire,
  type TeaserResponse,
} from '@/server/ai/schemas'

/**
 * The anonymous teaser cache.
 *
 * This is an abuse control that happens to look like a performance
 * optimisation. The anonymous reply comes from a fixed four-question form, not
 * from free-form chat, so the input space is small enough to cache — and that
 * is most of the reason the questionnaire is fixed. Someone determined to
 * bypass the one-prompt limit will clear cookies, open incognito windows and
 * cycle through a VPN, and every one of those attempts asks for the trip they
 * asked for a minute ago. Served from here, all of it costs us no AI spend at
 * all.
 *
 * So the key is the *answers* and nothing else: no visitor id, no session, no
 * timestamp. Two strangers who both ask for four days in Cox's Bazar for two
 * people on honeymoon get the same preview, which is correct — it is the same
 * question — and one model call between them.
 */

/**
 * The cache key: sha256 of the normalised `destination|days|partySize|purpose`.
 *
 * Hashed rather than stored raw for two reasons. It gives every key the same
 * fixed width, so a 120-character destination cannot strain the unique index;
 * and it keeps arbitrary visitor-supplied text out of a column that gets read
 * in logs and admin screens.
 *
 * The normalising — lowercased, whitespace collapsed — lives in
 * `teaserCacheKey`, beside the schema that defines the questionnaire, so this
 * module and anything else keying on the same answers cannot drift into two
 * ideas of what "the same question" means. "Cox's Bazar", "coxs bazar  " and
 * "COX'S BAZAR" have to be one entry, or retyping the destination becomes a way
 * to buy a second model call.
 */
export function teaserCacheHash(answers: TeaserQuestionnaire): string {
  return createHash('sha256').update(teaserCacheKey(answers)).digest('hex')
}

/** Prisma's "record to update not found". */
const RECORD_NOT_FOUND = 'P2025'

/**
 * Look for a cached reply, counting the hit.
 *
 * The read and the counter increment are one `UPDATE ... RETURNING`, not a
 * select followed by a write. That keeps `hitCount` honest under concurrency —
 * it is the number this cache is judged by, and a read-then-write would lose
 * counts under exactly the traffic that makes the cache worth having.
 *
 * A row whose payload no longer parses is a miss, not an error. The column is
 * `Json`, so it holds whatever an older deploy wrote or whatever somebody typed
 * into a database console; serving that to a visitor, or 500-ing on it, are
 * both worse than quietly regenerating.
 */
export async function readTeaserCache(
  answers: TeaserQuestionnaire
): Promise<TeaserResponse | null> {
  const cacheKey = teaserCacheHash(answers)

  let row: { payload: Prisma.JsonValue }

  try {
    row = await db.teaserCache.update({
      where: { cacheKey },
      data: { hitCount: { increment: 1 }, lastHitAt: new Date() },
      select: { payload: true },
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === RECORD_NOT_FOUND)
      return null
    throw e
  }

  const parsed = TeaserResponseSchema.safeParse(row.payload)

  if (!parsed.success) {
    console.warn(`[teaser-cache] entry ${cacheKey.slice(0, 12)} no longer parses; regenerating`)
    return null
  }

  return parsed.data
}

/**
 * Store a freshly generated reply.
 *
 * An upsert, because two visitors can ask the identical question in the same
 * second and both miss: the later write is a correction of the earlier one, not
 * a conflict worth failing a request over. `hitCount` is deliberately untouched
 * in the update branch — replacing a payload does not un-happen the hits it
 * already served.
 */
export async function writeTeaserCache(
  answers: TeaserQuestionnaire,
  payload: TeaserResponse
): Promise<void> {
  const cacheKey = teaserCacheHash(answers)
  // TeaserResponse is a plain object of strings, numbers and arrays — JSON by
  // construction — but Prisma's input type cannot learn that from an interface.
  const value = payload as unknown as Prisma.InputJsonValue

  await db.teaserCache.upsert({
    where: { cacheKey },
    create: { cacheKey, payload: value },
    update: { payload: value },
    select: { id: true },
  })
}
