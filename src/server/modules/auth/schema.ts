import { z } from 'zod'
import { AdminRole } from '@/generated/prisma/enums'
import { normalizeEmail } from '@/server/auth/email'

/**
 * The wire contract for /api/v1/auth and /api/v1/admin/auth.
 *
 * Every schema here is exported and named so the OpenAPI generator can emit it
 * as a component rather than inlining an anonymous shape at each call site —
 * hence the `.meta({ id })` on each one, which is what `z.toJSONSchema` turns
 * into a `$ref`.
 *
 * Request and response shapes live together on purpose. The response schemas
 * are the definition of what leaves the process, so anything absent here (a
 * password hash, an account status, a session id) has to be a deliberate
 * addition somewhere else rather than something that leaked in by default.
 */

/**
 * Length is the only password rule.
 *
 * NIST SP 800-63B says to verify length and screen against known-breached
 * passwords, and explicitly says NOT to impose composition rules. Requiring an
 * uppercase letter and a digit shrinks the search space in predictable ways
 * ("Password1!") while pushing users toward reuse, so ten characters with no
 * further constraints beats eight with four character classes.
 */
export const MIN_PASSWORD_LENGTH = 10

/**
 * An upper bound, not a strength rule.
 *
 * Argon2's cost is set by its memory and time parameters, not by input length,
 * but hashing is still work an unauthenticated caller can ask us to do, and
 * there is no reason to accept a megabyte of it.
 */
export const MAX_PASSWORD_LENGTH = 200

export const MAX_NAME_LENGTH = 120

/**
 * Opaque tokens are 32 CSPRNG bytes in base64url — 43 characters. The cap is
 * generous enough to survive a change of encoding and still refuse a payload
 * that exists only to make us hash it.
 */
const MAX_OPAQUE_TOKEN_LENGTH = 512

/**
 * RFC 5321's maximum forward-path length.
 *
 * The cap is applied before the format check, not after, and before the
 * lowercasing transform, so an oversized value is refused without ever being
 * copied. Without it an unauthenticated caller could post a multi-megabyte
 * "email": it satisfies the format regex, survives into the failed-login audit
 * row, and is written verbatim to a Json column that has no size bound of its
 * own — turning request bandwidth into permanent database storage. It would
 * also reach argon2 on the register path, buying a full password hash of CPU
 * per request, and then blow the 2704-byte btree limit on users_email_key,
 * surfacing a client mistake as a 500 with a stack trace.
 */
const MAX_EMAIL_LENGTH = 254

/**
 * Normalise first, then validate.
 *
 * The order matters and is not the obvious one: `z.email().trim()` runs the
 * format check against the raw input, so a pasted `" ada@example.com "` is
 * rejected before the whitespace is ever removed. Trimming through a transform
 * and piping the result into `z.email()` validates what we will actually store.
 *
 * The transform is `normalizeEmail` itself rather than an inline
 * `.trim().toLowerCase()`, so this schema and the seed script cannot drift into
 * two different ideas of what the canonical form is.
 */
export const EmailField = z
  .string()
  .max(MAX_EMAIL_LENGTH, `Email must be at most ${MAX_EMAIL_LENGTH} characters.`)
  .transform(normalizeEmail)
  .pipe(z.email({ error: 'Enter a valid email address.' }))
  .meta({
    id: 'Email',
    format: 'email',
    description: 'Case-insensitive. Stored and compared in lowercase.',
    examples: ['traveller@example.com'],
  })

export const PasswordField = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`)
  .meta({
    id: 'Password',
    description: `At least ${MIN_PASSWORD_LENGTH} characters. No character-class requirements.`,
  })

const NameField = z
  .string()
  .trim()
  .min(1, 'Name is required.')
  .max(MAX_NAME_LENGTH, `Name must be at most ${MAX_NAME_LENGTH} characters.`)

const OpaqueTokenField = z.string().min(1, 'Token is required.').max(MAX_OPAQUE_TOKEN_LENGTH)

// ─────────────────────────────────────────────────────────────────────────────
// Requests
// ─────────────────────────────────────────────────────────────────────────────

export const RegisterBody = z
  .object({
    email: EmailField,
    password: PasswordField,
    name: NameField,
  })
  .meta({ id: 'RegisterBody' })
export type RegisterBody = z.infer<typeof RegisterBody>

export const LoginBody = z
  .object({
    email: EmailField,
    // Deliberately not `PasswordField`. A login must not restate the password
    // policy: rejecting a nine-character attempt as "too short" while rejecting
    // a wrong one as "incorrect" tells an attacker something about the stored
    // password. Anything non-empty is accepted here and fails as credentials.
    password: z.string().min(1, 'Password is required.').max(MAX_PASSWORD_LENGTH),
  })
  .meta({ id: 'LoginBody' })
export type LoginBody = z.infer<typeof LoginBody>

export const RefreshBody = z.object({ refreshToken: OpaqueTokenField }).meta({ id: 'RefreshBody' })
export type RefreshBody = z.infer<typeof RefreshBody>

export const ForgotPasswordBody = z.object({ email: EmailField }).meta({ id: 'ForgotPasswordBody' })
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBody>

export const ResetPasswordBody = z
  .object({
    token: OpaqueTokenField,
    password: PasswordField,
  })
  .meta({ id: 'ResetPasswordBody' })
export type ResetPasswordBody = z.infer<typeof ResetPasswordBody>

// ─────────────────────────────────────────────────────────────────────────────
// Responses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A traveller as the outside world sees them.
 *
 * `passwordHash`, `status` and `phone` are absent by construction. Verification
 * is a boolean rather than the underlying `emailVerifiedAt` timestamp: clients
 * only ever branch on it, and the timestamp is an operational detail.
 */
export const PublicUser = z
  .object({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    // Not `z.url()` — this may legitimately be a path served from our own
    // origin rather than an absolute URL, and a response schema should
    // describe what the column can actually hold.
    avatarUrl: z.string().nullable(),
    emailVerified: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'PublicUser' })
export type PublicUser = z.infer<typeof PublicUser>

export const PublicAdmin = z
  .object({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    role: z.enum(AdminRole),
    avatarUrl: z.string().nullable(),
  })
  .meta({ id: 'PublicAdmin' })
export type PublicAdmin = z.infer<typeof PublicAdmin>

/**
 * What a refresh returns, and the token half of every session response.
 *
 * `expiresIn` describes the access token only. The refresh token outlives it by
 * a long way and carries no advertised lifetime, so a client is never invited
 * to treat the two as interchangeable.
 */
export const TokenPair = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresIn: z.int().positive().describe('Lifetime of accessToken, in seconds.'),
  })
  .meta({ id: 'TokenPair' })
export type TokenPair = z.infer<typeof TokenPair>

export const UserSessionResponse = TokenPair.extend({ user: PublicUser }).meta({
  id: 'UserSessionResponse',
})
export type UserSessionResponse = z.infer<typeof UserSessionResponse>

export const AdminSessionResponse = TokenPair.extend({ admin: PublicAdmin }).meta({
  id: 'AdminSessionResponse',
})
export type AdminSessionResponse = z.infer<typeof AdminSessionResponse>

/**
 * Either audience's session, discriminated by which principal key is present,
 * so a client reading `user` can never be handed an admin.
 */
export const SessionResponse = z
  .union([UserSessionResponse, AdminSessionResponse])
  .meta({ id: 'SessionResponse' })
export type SessionResponse = z.infer<typeof SessionResponse>

/**
 * The 202 from forgot-password.
 *
 * Worded in the conditional on purpose: the endpoint answers identically
 * whether or not the address is registered, so the copy the user reads has to
 * be consistent with that, or the wording itself becomes the oracle.
 */
export const AcceptedResponse = z.object({ message: z.string() }).meta({ id: 'AcceptedResponse' })
export type AcceptedResponse = z.infer<typeof AcceptedResponse>
