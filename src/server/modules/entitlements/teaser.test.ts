import { describe, expect, it } from 'vitest'
import { resetEnvCache } from '@/lib/env'
import { hashIp } from '@/server/auth/crypto'
import {
  TEASER_DAILY_GENERATION_CEILING,
  TEASER_DAILY_GENERATION_RULE,
  TEASER_REQUESTS_PER_IP_PER_HOUR,
  TEASER_REQUESTS_UNRESOLVED_PER_HOUR,
  teaserIpRule,
} from './teaser'

/**
 * The two limits that bound what the anonymous surface can cost.
 *
 * Everything else here meters a visitor, and every signal that picks which
 * visitor is one the caller supplies. These do not, and the cases below are the
 * reasons they do not: the per-address key is a digest of an address rather
 * than the address, an unresolvable caller shares one pool instead of being
 * handed a private one, and the daily ceiling is a constant rather than
 * something reachable from an admin console at 2am.
 */

process.env.DATABASE_URL =
  'postgresql://tester:not-a-real-password@localhost:5432/beyond_borders_test'
process.env.AUTH_USER_SECRET = 'test-user-secret-0123456789-abcdefghij'
process.env.AUTH_ADMIN_SECRET = 'test-admin-secret-0123456789-abcdefghij'
resetEnvCache()

/** RFC 5737 documentation range — never a real address. */
const IP = '203.0.113.7'
const OTHER_IP = '203.0.113.8'

describe('teaserIpRule', () => {
  it('keys on a salted digest, never on the address itself', () => {
    const rule = teaserIpRule(IP)

    // The bucket key is written to a table and read back in logs. It must not
    // turn the limiter into a record of who asked for what and when.
    expect(rule.key).not.toContain(IP)
    expect(rule.key).toBe(`teaser:ip:${hashIp(IP)}`)
  })

  it('gives two addresses two allowances', () => {
    expect(teaserIpRule(IP).key).not.toBe(teaserIpRule(OTHER_IP).key)
    expect(teaserIpRule(IP).limit).toBe(TEASER_REQUESTS_PER_IP_PER_HOUR)
  })

  it('is stable for one address, so a caller cannot rotate their own bucket', () => {
    expect(teaserIpRule(IP).key).toBe(teaserIpRule(IP).key)
  })

  it('pools every unresolvable caller into ONE shared allowance', () => {
    // The load-bearing case. With TRUSTED_PROXY_HOPS at 0 there is no way to
    // tell two anonymous callers apart, so a private allowance each would be a
    // private allowance per request — which is no limit at all. One shared pool
    // is the honest reading of "we do not know who this is".
    const rule = teaserIpRule(null)

    expect(rule.key).toBe('teaser:ip:unresolved')
    expect(rule.limit).toBe(TEASER_REQUESTS_UNRESOLVED_PER_HOUR)
    expect(teaserIpRule(null).key).toBe(rule.key)
  })

  it('never lets an unresolved caller share a bucket with a resolved one', () => {
    expect(teaserIpRule(null).key).not.toBe(teaserIpRule(IP).key)
  })

  it('limits by the hour', () => {
    expect(teaserIpRule(IP).windowSeconds).toBe(3_600)
    expect(teaserIpRule(null).windowSeconds).toBe(3_600)
  })
})

describe('TEASER_DAILY_GENERATION_RULE', () => {
  it('is one global bucket over a 24-hour window', () => {
    // Global on purpose: this counts money rather than callers, so it must not
    // be divisible by opening more sessions.
    expect(TEASER_DAILY_GENERATION_RULE.key).toBe('teaser:generate:global')
    expect(TEASER_DAILY_GENERATION_RULE.windowSeconds).toBe(86_400)
    expect(TEASER_DAILY_GENERATION_RULE.limit).toBe(TEASER_DAILY_GENERATION_CEILING)
  })

  it('is a deliberate bounded number rather than a placeholder', () => {
    // Zero would take the product away; an enormous one would not be a ceiling.
    // The value itself is argued for in the constant's own comment.
    expect(TEASER_DAILY_GENERATION_CEILING).toBeGreaterThan(0)
    expect(TEASER_DAILY_GENERATION_CEILING).toBeLessThanOrEqual(5_000)
  })

  it('bounds the day well below what the per-address limits alone would allow', () => {
    // The two limits are not redundant. The per-address one caps a single
    // network; the ceiling is what caps the bill when a hundred of them show up
    // together, which no per-address limit can do.
    expect(TEASER_DAILY_GENERATION_CEILING).toBeLessThan(
      TEASER_REQUESTS_PER_IP_PER_HOUR * 24 * 100
    )
  })
})
