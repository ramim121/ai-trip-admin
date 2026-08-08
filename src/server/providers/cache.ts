import 'server-only'
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'

/**
 * A shared cache for outside providers, kept in Postgres.
 *
 * LOAD-BEARING RATHER THAN AN OPTIMISATION. Google Places bills per call, and
 * its Enterprise-tier fields — rating, photos — carry roughly a thousand free
 * calls a month; without this, one busy afternoon spends the month. Viator's own
 * terms expect product data to be cached and refreshed periodically rather than
 * fetched per page view, so caching is alignment with their rules and not merely
 * a way to be quick.
 *
 * IN POSTGRES RATHER THAN IN MEMORY, because this runs serverless: instances are
 * created and discarded per request, so a process-local map would be cold almost
 * every time and would multiply calls by the number of live instances instead of
 * dividing them.
 *
 * Every row must expire. One that never does is a copy of somebody else's
 * database, which is the thing both providers' terms forbid — and a CHECK
 * constraint enforces it rather than trusting every caller to pass a TTL.
 */

/**
 * A digest that does not depend on key order.
 *
 * Two requests differing only in the order the caller happened to build them
 * must hit the same row. Without this the cache appears to work while quietly
 * missing most of the time — a failure that presents as a quota problem rather
 * than as a bug.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)

  return `{${entries.join(',')}}`
}

export function cacheKeyFor(provider: string, endpoint: string, request: unknown): string {
  return createHash('sha256')
    .update(`${provider} ${endpoint} ${stableStringify(request)}`)
    .digest('hex')
}

export interface CacheOptions {
  provider: string
  endpoint: string
  request: unknown
  /** How long the answer stays useful. Search results age faster than records. */
  ttlSeconds: number
}

/**
 * Read a cached payload, or null when there is nothing usable.
 *
 * Expiry is compared inside the query rather than after it, so an expired row
 * never reaches a caller even if the sweep has not run — the sweep is
 * housekeeping for disk, never for correctness.
 *
 * NEVER THROWS. Postgres being briefly unavailable should cost a cache hit and
 * nothing else; turning that into a failed search would make the cache a new way
 * for the feature to break.
 */
export async function readCache<T>(options: CacheOptions): Promise<T | null> {
  const cacheKey = cacheKeyFor(options.provider, options.endpoint, options.request)

  try {
    const row = await db.providerCache.findFirst({
      where: { cacheKey, expiresAt: { gt: new Date() } },
      select: { payload: true },
    })

    return row === null ? null : (row.payload as T)
  } catch (error) {
    console.error(`[cache] read failed for ${options.provider}/${options.endpoint}:`, error)
    return null
  }
}

/**
 * Store a payload.
 *
 * An upsert, because two requests racing for the same cold key is the ordinary
 * case rather than an edge one — both fetch, both write, and the later answer is
 * as good as the earlier.
 *
 * Also never throws, for the same reason as the read: failing to remember
 * something must not fail the request that already holds the answer.
 */
export async function writeCache(options: CacheOptions, payload: unknown): Promise<void> {
  const cacheKey = cacheKeyFor(options.provider, options.endpoint, options.request)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + options.ttlSeconds * 1000)

  try {
    await db.providerCache.upsert({
      where: { cacheKey },
      create: {
        cacheKey,
        provider: options.provider,
        endpoint: options.endpoint,
        payload: payload as never,
        fetchedAt: now,
        expiresAt,
      },
      update: { payload: payload as never, fetchedAt: now, expiresAt },
    })
  } catch (error) {
    console.error(`[cache] write failed for ${options.provider}/${options.endpoint}:`, error)
  }
}

/**
 * Fetch through the cache.
 *
 * The shape every caller wants: ask the cache, call the provider on a miss,
 * remember the answer. `fetcher` runs only on a miss, so a cached answer costs
 * one indexed lookup and no quota.
 */
export async function cached<T>(options: CacheOptions, fetcher: () => Promise<T>): Promise<T> {
  const hit = await readCache<T>(options)
  if (hit !== null) return hit

  const fresh = await fetcher()
  await writeCache(options, fresh)

  return fresh
}

/**
 * Drop expired rows.
 *
 * Housekeeping for disk only — reads already filter on `expiresAt`, so nothing
 * here changes what a caller sees. Safe to run from a cron, and safe never to
 * run at all.
 */
export async function sweepExpiredCache(): Promise<number> {
  const { count } = await db.providerCache.deleteMany({ where: { expiresAt: { lte: new Date() } } })
  return count
}
