import type { z } from 'zod'
import { db } from '@/lib/db'

/**
 * Reading runtime configuration out of the `settings` table.
 *
 * Every value in that table is admin-editable, which means every value in it is
 * also admin-*breakable*: a row hand-edited into nonsense, or a row that a newer
 * deploy writes in a shape an older instance has never seen. So nothing here
 * ever throws. A missing row, an unreadable database and a row that fails its
 * schema all return `null`, and the caller supplies the constant it falls back
 * to.
 *
 * That is the rule worth stating out loud: the fallback lives at the call site,
 * in code, not in this module. A limit that silently becomes `undefined`
 * because a row went missing is how an enforcement check turns into no
 * enforcement at all.
 */

/**
 * How long a value is trusted before the row is re-read.
 *
 * These settings change a few times a year and are read on hot paths, so a
 * per-request round trip to Postgres would be a poor trade. Thirty seconds
 * matches the AI provider cache, so ops sees one consistent lag across the
 * console rather than two different ones.
 */
export const SETTING_TTL_MS = 30_000

interface CacheEntry {
  /** `null` is a legitimate cached result — see `readCachedSetting`. */
  value: unknown
  readAt: number
}

const cache = new Map<string, CacheEntry>()

/**
 * Read and validate one settings row. No cache, no throw.
 *
 * The schema is not decoration: `value` is a `Json` column, so what comes back
 * is `unknown` in the most literal sense, and every caller of this function is
 * about to use the result to decide what somebody is allowed to do.
 */
export async function readSetting<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
  let raw: unknown

  try {
    const row = await db.setting.findUnique({ where: { key }, select: { value: true } })
    if (row === null) return null
    raw = row.value
  } catch (e) {
    const description = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    console.warn(
      `[settings] could not read "${key}", falling back to code defaults: ${description}`
    )
    return null
  }

  const parsed = schema.safeParse(raw)

  if (!parsed.success) {
    console.warn(
      `[settings] row "${key}" does not match its expected shape, falling back to code defaults`
    )
    return null
  }

  return parsed.data
}

/**
 * Same, through a short TTL cache.
 *
 * A `null` result is cached too, deliberately. The common cause of `null` is a
 * row that has never been seeded, and re-querying for it on every request would
 * turn a missing row into permanent load on the database — the one shape of
 * failure a cache exists to prevent.
 */
export async function readCachedSetting<T>(
  key: string,
  schema: z.ZodType<T>,
  ttlMs: number = SETTING_TTL_MS
): Promise<T | null> {
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() - hit.readAt < ttlMs) return hit.value as T | null

  const value = await readSetting(key, schema)
  cache.set(key, { value, readAt: Date.now() })
  return value
}

/**
 * Drop the cache.
 *
 * Call this after writing a settings row so the change takes effect at once
 * instead of up to `SETTING_TTL_MS` later. Also the reset hook for tests.
 */
export function clearSettingCache(): void {
  cache.clear()
}
