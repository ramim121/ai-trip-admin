import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import type { Algorithm } from '@node-rs/argon2'
import { env } from '@/lib/env'

/**
 * Cryptographic primitives for authentication.
 *
 * Two distinct jobs live here and must not be confused:
 *
 *  - Passwords are hashed with Argon2id, which is deliberately slow, because an
 *    attacker who steals the table would otherwise brute-force them offline.
 *  - Session and lifecycle tokens are hashed with SHA-256, which is fast. That
 *    is correct here: these tokens are 256 bits of CSPRNG output, so there is
 *    no low-entropy space to search and no reason to pay Argon2's cost on every
 *    request.
 */

// OWASP Password Storage Cheat Sheet, Argon2id: m=19456 KiB, t=2, p=1.
// The library's defaults (m=4096, t=3) are weaker on memory, which is the
// parameter that actually frustrates GPU cracking — so set these explicitly.
// @node-rs/argon2 declares `Algorithm` as an ambient const enum, which
// isolatedModules forbids dereferencing, so the value is inlined here.
// Argon2id === 2 in that enum.
const ARGON2ID = 2 as Algorithm

const ARGON_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

export async function hashPassword(plaintext: string): Promise<string> {
  return argonHash(plaintext, ARGON_OPTIONS)
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupted row
 * should read as "wrong password", never as a 500 that tells an attacker the
 * account exists and is in an unusual state.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await argonVerify(storedHash, plaintext, ARGON_OPTIONS)
  } catch {
    return false
  }
}

/**
 * Burn roughly one password verification of CPU time.
 *
 * Login must take the same time whether or not the email exists, otherwise the
 * response time alone reveals which addresses are registered. Call this on the
 * user-not-found branch.
 *
 * The decoy hash is generated once per process from throwaway input, so it
 * costs the same as a genuine verification while authenticating nothing.
 */
let decoyHash: string | null = null

export async function fakePasswordVerification(): Promise<void> {
  decoyHash ??= await argonHash(randomBytes(16).toString('hex'), ARGON_OPTIONS)
  await argonVerify(decoyHash, 'not-the-password', ARGON_OPTIONS).catch(() => false)
}

/** 256 bits of CSPRNG output, URL-safe. Returned to the client exactly once. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

/** What we actually persist. A database leak yields hashes, not usable tokens. */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

/**
 * Pseudonymise an IP for anomaly detection.
 *
 * Salted with a server secret so the digests cannot be reversed with a rainbow
 * table of the ~4 billion IPv4 addresses. Truncated because we only need to
 * compare, never to recover.
 */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  return createHash('sha256').update(`${env().AUTH_ADMIN_SECRET}:${ip}`).digest('hex').slice(0, 32)
}

/**
 * Pseudonymise a device fingerprint, the same salted way as an IP.
 *
 * Same construction, same secret, different domain label — so a fingerprint and
 * an IP that happen to be the same string do not produce the same digest and
 * quietly fuse two unrelated visitors into one.
 *
 * The label sits inside the hashed input rather than beside the digest. An
 * attacker could still force agreement between the two functions by sending
 * `X-Forwarded-For: fingerprint:<value>`, and it buys them nothing: both
 * digests are *matching* signals in the anonymous-visitor union, and matching
 * more visitors only ever narrows what they are allowed to do.
 */
export function hashFingerprint(fingerprint: string | null | undefined): string | null {
  if (!fingerprint) return null
  return createHash('sha256')
    .update(`${env().AUTH_ADMIN_SECRET}:fingerprint:${fingerprint}`)
    .digest('hex')
    .slice(0, 32)
}

/** Compare two hex digests without leaking their contents through timing. */
export function safeCompareHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}
