import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetEnvCache } from '@/lib/env'
import { clientContext, resolveClientIp } from './guards'

/**
 * Resolving the client address out of `x-forwarded-for`.
 *
 * This arithmetic decides which address the anonymous quota and the rate
 * limiter are keyed on, and getting it wrong is silently exploitable rather
 * than loudly broken — the previous version took the LEFTMOST entry, which is
 * the one the caller writes, so every request could name its own quota identity
 * and everything downstream believed it. The cases below are written from the
 * attacker's side first for that reason.
 *
 * Every address here is from RFC 5737 (203.0.113.0/24, 198.51.100.0/24) or RFC
 * 3849 (2001:db8::/32), so none of them is routable anywhere.
 */

process.env.DATABASE_URL =
  'postgresql://tester:not-a-real-password@localhost:5432/beyond_borders_test'
process.env.AUTH_USER_SECRET = 'test-user-secret-0123456789-abcdefghij'
process.env.AUTH_ADMIN_SECRET = 'test-admin-secret-0123456789-abcdefghij'

/** What an attacker types into the header. */
const SPOOFED = '198.51.100.66'
/** What the outermost proxy of ours actually observed. */
const CLIENT = '203.0.113.7'
/** Our own edges, appended left to right as the request came in. */
const EDGE_INNER = '203.0.113.201'
const EDGE_OUTER = '203.0.113.202'

function withHops(hops: number): void {
  process.env.TRUSTED_PROXY_HOPS = String(hops)
  resetEnvCache()
}

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest('https://api.example.test/api/v1/planner/teaser', {
    method: 'POST',
    headers,
  })
}

beforeEach(() => {
  withHops(0)
})

describe('resolveClientIp — the attacker cases', () => {
  it('ignores a forged chain entirely when no proxy is trusted', () => {
    // The default. Nothing of ours appended anything, so every byte of this
    // header was written by the caller and none of it is evidence.
    expect(resolveClientIp(SPOOFED, 0)).toBeNull()
    expect(resolveClientIp(`${SPOOFED}, ${CLIENT}`, 0)).toBeNull()
  })

  it('takes the entry our proxy appended, not the one the caller prepended', () => {
    // `curl -H 'X-Forwarded-For: 198.51.100.66'` through one proxy of ours
    // arrives as "<their value>, <what our proxy saw>". Reading left to right
    // — which is what this used to do — hands the attacker the answer.
    expect(resolveClientIp(`${SPOOFED}, ${CLIENT}`, 1)).toBe(CLIENT)
    expect(resolveClientIp(`${SPOOFED}, ${CLIENT}`, 1)).not.toBe(SPOOFED)
  })

  it('cannot be walked back by prepending more entries', () => {
    // The attacker's only lever is the left-hand side, and counting from the
    // right is immune to how much they pile up there.
    const padded = `${SPOOFED}, ${SPOOFED}, ${SPOOFED}, ${CLIENT}`

    expect(resolveClientIp(padded, 1)).toBe(CLIENT)
  })

  it('counts in from the right through several trusted hops', () => {
    // Cloudflare in front of nginx: the client sits two entries from the end.
    const chain = `${SPOOFED}, ${CLIENT}, ${EDGE_INNER}`

    expect(resolveClientIp(chain, 2)).toBe(CLIENT)
    expect(resolveClientIp(`${chain}, ${EDGE_OUTER}`, 3)).toBe(CLIENT)
  })

  it('refuses a chain shorter than the configured depth instead of guessing', () => {
    // Two hops configured but only one entry present means the request did not
    // cross the proxies we believe it did, so nothing in it can be attributed
    // to an edge we run. Falling back to "whatever is leftmost" here would
    // restore the original bug in a single line.
    expect(resolveClientIp(SPOOFED, 2)).toBeNull()
    expect(resolveClientIp(`${SPOOFED}, ${CLIENT}`, 3)).toBeNull()
  })

  it('resolves the sole entry when the caller sent no chain of their own', () => {
    // One trusted hop, nothing prepended: the whole header is our proxy's work.
    expect(resolveClientIp(CLIENT, 1)).toBe(CLIENT)
  })
})

describe('resolveClientIp — parsing', () => {
  it('returns null for an absent or empty header', () => {
    expect(resolveClientIp(null, 1)).toBeNull()
    expect(resolveClientIp(undefined, 1)).toBeNull()
    expect(resolveClientIp('', 1)).toBeNull()
    expect(resolveClientIp('   ', 1)).toBeNull()
  })

  it('tolerates the whitespace and empty entries real proxies emit', () => {
    expect(resolveClientIp(`  ${SPOOFED} ,  ${CLIENT}  `, 1)).toBe(CLIENT)
    expect(resolveClientIp(`${SPOOFED}, , ${CLIENT}`, 1)).toBe(CLIENT)
  })

  it('strips a transport port, so one caller is one bucket', () => {
    // A port left attached makes every TCP connection a distinct rate-limit
    // key, which is a rate limiter that does not limit.
    expect(resolveClientIp(`${CLIENT}:41234`, 1)).toBe(CLIENT)
    expect(resolveClientIp('[2001:db8::1]:443', 1)).toBe('2001:db8::1')
  })

  it('leaves a bare IPv6 address alone despite its colons', () => {
    expect(resolveClientIp('2001:db8::1', 1)).toBe('2001:db8::1')
  })

  it('refuses an entry too long to be an address', () => {
    // The resolved value becomes a rate-limit bucket key, so it must not be a
    // place to stuff arbitrary bytes.
    expect(resolveClientIp('9'.repeat(200), 1)).toBeNull()
  })
})

describe('clientContext', () => {
  it('resolves no address at all under the default configuration', () => {
    const ctx = clientContext(request({ 'x-forwarded-for': `${SPOOFED}, ${CLIENT}` }))

    // TRUSTED_PROXY_HOPS defaults to 0, and Next removed NextRequest.ip in
    // v15, so there is no socket peer to fall back on either. "We do not know"
    // is the honest answer, and it beats a value we cannot vouch for.
    expect(ctx.ip).toBeNull()
  })

  it('reads the hop count from the environment', () => {
    withHops(1)

    expect(clientContext(request({ 'x-forwarded-for': `${SPOOFED}, ${CLIENT}` })).ip).toBe(CLIENT)
  })

  it('ignores x-real-ip even when it is the only thing on offer', () => {
    withHops(1)

    // Dropped deliberately: it carries no hop information, so there is no
    // configuration under which an edge-set value could be told apart from one
    // the caller invented.
    expect(clientContext(request({ 'x-real-ip': SPOOFED })).ip).toBeNull()
  })

  it('does not let x-real-ip override a properly resolved address', () => {
    withHops(1)

    const ctx = clientContext(request({ 'x-forwarded-for': CLIENT, 'x-real-ip': SPOOFED }))

    expect(ctx.ip).toBe(CLIENT)
  })

  it('truncates the user agent to what the column holds', () => {
    const ctx = clientContext(request({ 'user-agent': 'u'.repeat(1_000) }))

    expect(ctx.userAgent).toHaveLength(255)
  })

  it('reports a missing user agent as null rather than as an empty string', () => {
    expect(clientContext(request({})).userAgent).toBeNull()
  })
})
