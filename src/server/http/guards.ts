import type { NextRequest } from 'next/server'
import type { AdminRole } from '@/generated/prisma/enums'
import { env } from '@/lib/env'
import { verifyAccessToken, type AdminAccessClaims, type UserAccessClaims } from '@/server/auth/jwt'
import { forbidden, unauthorized } from './errors'

/**
 * Per-request authentication and authorisation.
 *
 * A guard either returns claims or throws — there is no "maybe authenticated"
 * value a handler could forget to check. Travellers and staff are verified
 * against different secrets and different audiences (see auth/jwt.ts), so
 * `requireUser` can never be satisfied by an admin token or the reverse.
 */

/** Length cap matching what the refresh-token and audit tables expect. */
const USER_AGENT_MAX_LENGTH = 255

/**
 * Longest thing we will accept as an address.
 *
 * A full IPv6 address with a zone identifier is 45-odd characters. Anything
 * beyond this cap is not an address, and since the resolved value becomes a
 * rate-limit bucket key it must not be a place to stuff arbitrary bytes.
 */
const IP_MAX_LENGTH = 64

/**
 * Pull the credential out of `Authorization: Bearer <token>`.
 *
 * The scheme is compared case-insensitively because RFC 7235 defines it that
 * way and real clients do send `bearer`.
 */
function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get('authorization')
  if (!header) return null

  const separator = header.indexOf(' ')
  if (separator === -1) return null

  if (header.slice(0, separator).toLowerCase() !== 'bearer') return null

  const token = header.slice(separator + 1).trim()
  return token.length > 0 ? token : null
}

/**
 * Require a signed-in traveller.
 *
 * Missing, malformed, expired and forged tokens all produce the same 401: the
 * caller learns that it must authenticate, and nothing more.
 */
export async function requireUser(req: NextRequest): Promise<UserAccessClaims> {
  const token = bearerToken(req)
  if (!token) throw unauthorized()

  const claims = await verifyAccessToken(token, 'user')
  if (!claims) throw unauthorized()

  return claims
}

/**
 * Identify a traveller if there is one, without insisting on it.
 *
 * For the endpoints that serve both audiences — the anonymous teaser is the
 * first — where being signed in changes which quota applies rather than whether
 * the request is allowed at all.
 *
 * A malformed or expired token returns null and the caller is treated as
 * anonymous. That is the safe direction: the anonymous path is the more
 * restricted one, so a broken token costs its holder their signed-in
 * allowances and can never grant them any. Refusing instead would let an
 * expired token break a public page.
 *
 * Never use this where authorisation is the question. `requireUser` throws for
 * a reason, and "maybe authenticated" is a value a handler can forget to check.
 */
export async function optionalUser(req: NextRequest): Promise<UserAccessClaims | null> {
  const token = bearerToken(req)
  if (!token) return null

  return verifyAccessToken(token, 'user')
}

/**
 * Require a signed-in staff member, optionally in one of `allowedRoles`.
 *
 * Omitting `allowedRoles` means "any role" — the route is open to all staff.
 * Passing a list restricts it; SUPER_ADMIN always satisfies the list, which is
 * what keeps the top role from being locked out of a route somebody scoped
 * to OPS.
 *
 * Note that this checks the *token*, not the database: an admin disabled since
 * their access token was minted stays valid until it expires. Revocation is
 * enforced at the refresh layer, so the exposure is one access-token TTL.
 */
export async function requireAdmin(
  req: NextRequest,
  allowedRoles?: AdminRole[]
): Promise<AdminAccessClaims> {
  const token = bearerToken(req)
  if (!token) throw unauthorized()

  const claims = await verifyAccessToken(token, 'admin')
  if (!claims) throw unauthorized()

  if (allowedRoles && allowedRoles.length > 0) {
    const permitted = claims.role === 'SUPER_ADMIN' || allowedRoles.includes(claims.role)
    if (!permitted) throw forbidden()
  }

  return claims
}

/**
 * Strip a transport port from one `x-forwarded-for` entry.
 *
 * Most reverse proxies write a bare address, but some write `203.0.113.7:41234`
 * or `[2001:db8::1]:443`. Left alone, the port turns a per-client rate-limit key
 * into a per-TCP-connection one — a new bucket for every request, which is a
 * rate limiter that does not limit.
 */
function withoutPort(entry: string): string {
  // The bracketed form is the only unambiguous one, so handle it first.
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']')
    return close === -1 ? entry : entry.slice(1, close)
  }

  // A bare IPv6 address is full of colons, so only split when there is exactly
  // one — which makes it `host:port` and nothing else.
  const first = entry.indexOf(':')
  if (first !== -1 && first === entry.lastIndexOf(':')) return entry.slice(0, first)

  return entry
}

/**
 * The client address an `x-forwarded-for` chain actually attests to, or null.
 *
 * Exported for its own tests, because this arithmetic is the whole guard and
 * an off-by-one in it is silently exploitable rather than loudly broken.
 *
 * Proxies APPEND: each one adds the peer it saw to the right-hand end. So for
 * a request that crossed two proxies of ours the header reads
 *
 *     <whatever the caller typed>, <real client>, <our outer proxy>
 *
 * and the real client sits `trustedHops` from the right — `chain[len - hops]`.
 * Everything to the left of that is caller-authored and is thrown away.
 *
 * Two refusals, both deliberate:
 *
 *   - `trustedHops === 0` resolves nothing. With no proxy of ours in the path,
 *     every byte of this header was written by the caller. Next removed
 *     `NextRequest.ip` in v15, so there is no socket peer to fall back on
 *     either, and "no IP" is the only honest answer.
 *   - A chain SHORTER than the configured depth resolves nothing. It means the
 *     request did not traverse the proxies we believe it did, so no entry in it
 *     can be attributed to an edge we control. Falling back to "whatever is
 *     leftmost" there would restore exactly the bug this replaces: an attacker
 *     sends one made-up entry and it lands in the trusted position.
 */
export function resolveClientIp(
  forwardedFor: string | null | undefined,
  trustedHops: number
): string | null {
  if (trustedHops <= 0 || !forwardedFor) return null

  const chain = forwardedFor
    .split(',')
    .map((entry) => withoutPort(entry.trim()))
    .filter((entry) => entry.length > 0)

  if (chain.length < trustedHops) return null

  const client = chain[chain.length - trustedHops]

  return client && client.length <= IP_MAX_LENGTH ? client : null
}

/**
 * Where the request appears to come from.
 *
 * This used to take the LEFTMOST `x-forwarded-for` entry, on the reasoning that
 * the chain grows left to right so the first entry is closest to the client.
 * The direction is right and the conclusion was backwards. Proxies append on
 * the RIGHT, so the leftmost entry is the one nobody vouched for: it is
 * whatever the caller put in the header before the first proxy ever saw the
 * request. `curl -H 'X-Forwarded-For: 1.2.3.4'` therefore chose its own quota
 * identity, a fresh one per request, for free — and the anonymous limit, which
 * counts this address as one of its three signals, stopped existing.
 *
 * Now the address is counted in from the right using `TRUSTED_PROXY_HOPS`, and
 * `x-real-ip` is no longer consulted at all: it carries no hop information, so
 * there is no configuration under which we could distinguish a value our edge
 * set from one the caller invented. Where the hop count gives an answer we
 * already have the better one; where it does not, `x-real-ip` would only be
 * laundering caller input into a field that looks authoritative.
 *
 * A null `ip` is a normal, expected outcome — the default configuration
 * produces it — so every caller must handle it as "we do not know" rather than
 * as a usable key. `server/http/rate-limit.ts` pools unresolved callers into a
 * single shared allowance for exactly this reason.
 *
 * The IP is returned raw; persist it through `hashIp()` from auth/crypto, never
 * as-is. It stays a rate-limiting and anomaly-detection signal only — never an
 * authorisation one, because even a correctly-resolved address only tells us
 * which network a request crossed, not who sent it.
 */
export function clientContext(req: NextRequest): { ip: string | null; userAgent: string | null } {
  const ip = resolveClientIp(req.headers.get('x-forwarded-for'), env().TRUSTED_PROXY_HOPS)

  // Truncated because the column is sized for it and because an unbounded
  // header should not decide how much we write to the database.
  const rawUserAgent = req.headers.get('user-agent')?.trim()
  const userAgent = rawUserAgent ? rawUserAgent.slice(0, USER_AGENT_MAX_LENGTH) : null

  return { ip, userAgent }
}
