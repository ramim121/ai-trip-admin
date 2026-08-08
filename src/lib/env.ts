import { z } from 'zod'

/**
 * Validated server environment.
 *
 * Parsing is lazy and cached: reading `process.env` at module load would make
 * `next build` fail on machines that legitimately have no secrets, since Next
 * evaluates route modules during the build. The first actual access validates.
 */

/**
 * A boolean written by a human into a `.env` file.
 *
 * `z.coerce.boolean()` is the trap this avoids: it is `Boolean(value)`, under
 * which the string `"false"` is `true`. For a flag whose entire job is to keep a
 * fake payment gateway switched off, "the operator typed false and got true" is
 * not a rounding error.
 *
 * `z.stringbool()` accepts the spellings people actually use — true/false, 1/0,
 * yes/no, on/off, enabled/disabled, case-insensitively — and REJECTS anything
 * else rather than guessing. A typo therefore fails the boot loudly instead of
 * resolving to whichever value the typo happened to be falsy under.
 */
const EnvBoolean = z.stringbool()

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    // Separate secrets per audience: a stolen traveller token must be
    // unverifiable against admin routes even if the algorithm matches.
    AUTH_USER_SECRET: z.string().min(32, 'AUTH_USER_SECRET must be at least 32 characters'),
    AUTH_ADMIN_SECRET: z.string().min(32, 'AUTH_ADMIN_SECRET must be at least 32 characters'),

    AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    AUTH_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),

    // Absolute ceiling on a login, independent of how often it is refreshed.
    // Rotation slides the refresh window forward, so without this a single
    // stolen token refreshed monthly would never expire. 90 days.
    AUTH_SESSION_MAX_SECONDS: z.coerce.number().int().positive().default(7_776_000),

    AI_PROVIDER: z.enum(['google', 'openai', 'anthropic']).default('google'),

    // `gemini-2.5-flash` was the default until Google retired it for new keys —
    // it now answers "no longer available to new users", which would have taken
    // the planner down on any deployment that did not override it.
    AI_MODEL: z.string().default('gemini-flash-latest'),

    /**
     * A cheaper model for calls whose output shape is forced by a JSON schema —
     * the teaser today, activity-suggestion ranking next.
     *
     * `gemini-3.1-flash-lite`, and NOT a Gemma model, which is worth recording
     * because Gemma looks like the obvious pick. Measured against
     * `gemma-4-31b-it` on this key:
     *
     *   - It does not follow instructions. Told "reply with exactly one word:
     *     BANANA", it answers `* Input: … * Constraint 1: …`, narrating the
     *     request rather than obeying it — in the system role and the user role
     *     alike, since Gemma has no system role on this API and so offers no
     *     position from which a rule can bind.
     *   - It handles a two-field schema, then TIMED OUT past five minutes on the
     *     real nested TeaserResponseSchema. Flash-lite returns the same shape in
     *     under a second.
     *
     * The first point alone rules it out of the planner, whose guarantees
     * (recommend only what the catalog returned, never disclose these
     * instructions) are carried by the prompt. The second rules it out here too.
     *
     * Unset falls back to AI_MODEL, which is always safe.
     */
    AI_MODEL_CHEAP: z.string().optional(),
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),

    /**
     * Google Places (New). Optional — without it the import screen says so and
     * nothing else in the console is affected.
     *
     * A SEPARATE KEY FROM `GOOGLE_GENERATIVE_AI_API_KEY` even though both are
     * Google. They are different products with different quotas and different
     * blast radii: one spends model tokens and the other spends Places lookups,
     * so a single key for both means rotating either takes down the other.
     *
     * Server-side only, and deliberately no `NEXT_PUBLIC_` variant. A Places key
     * in a browser bundle is a key anybody can spend — the usual way that
     * happens is a map component, which is why this whole flow stays
     * server-rendered.
     */
    GOOGLE_PLACES_API_KEY: z.string().optional(),

    /**
     * Viator Partner API. Optional — without it the tours pillar of the journey
     * planner says so, and everything else still works.
     *
     * TWO KEYS, because Viator runs two hosts with separate credentials and a
     * key issued for one is refused by the other. `VIATOR_USE_SANDBOX` chooses
     * between them rather than the code inferring it from NODE_ENV: which host
     * to call is a property of the key you were given, not of where the process
     * happens to be running, and a staging deploy may legitimately want live
     * inventory.
     *
     * Server-side only, no `NEXT_PUBLIC_` variant — this is a billable
     * credential attached to an affiliate account.
     */
    VIATOR_API_KEY: z.string().optional(),
    VIATOR_SANDBOX_API_KEY: z.string().optional(),
    VIATOR_USE_SANDBOX: z
      .string()
      .optional()
      .transform((value) => value === 'true'),

    PUBLIC_WEB_ORIGIN: z.url().default('http://localhost:3000'),
    ADMIN_ORIGIN: z.url().default('http://localhost:3001'),

    // How many reverse proxies WE operate in front of this process.
    //
    // Each proxy appends the peer it saw to the right-hand end of
    // `x-forwarded-for`, so this number is the only thing that says where the
    // attacker-written part of that header stops and ours begins. See
    // `clientContext()` in server/http/guards.ts, which counts in from the
    // right by exactly this many entries.
    //
    // Default 0 — trust nothing, resolve no IP at all. That is correct for a
    // process reachable directly, and it is the safe direction to be wrong in:
    // set too HIGH and no IP resolves at all (a chain shorter than the
    // configured depth is refused outright), set too LOW and the address we
    // meter on is one the caller typed. Raise it only to the number of hops
    // that genuinely append.
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    // ── The sandbox payment gateway ──────────────────────────────────────────
    //
    // Two flags rather than one, and they are not redundant. A mock gateway
    // that settles on a button press grants real entitlements: an
    // ItineraryUnlock row, a Subscription row, the full-length trip somebody
    // would otherwise have paid 200 BDT for. Reaching production switched on,
    // it is not a bug in a test tool — it is the paywall, removed, by anyone
    // who can read a URL.
    //
    // One flag is one accident away from that. Environment variables get
    // copied between deployments wholesale, a `.env` gets pasted into a
    // dashboard, a staging config becomes the template for production. The
    // second flag exists so that the accident has to happen twice, to two
    // differently-named variables, one of which says the word PRODUCTION out
    // loud.
    //
    // Neither is read at the route layer. `assertMockPaymentsPermitted()` in
    // server/payments/mock.ts is the single place both are evaluated, so there
    // is no second copy of the rule for anyone to get subtly wrong.

    /**
     * Whether the sandbox gateway may be used at all.
     *
     * Absent means TRUE in development and FALSE everywhere else — including
     * `test`, which is deliberate: the suite proves refusals, and a runner that
     * silently enabled the thing being refused would prove nothing. Tests that
     * exercise the happy path set it explicitly.
     */
    PAYMENTS_MOCK_ENABLED: EnvBoolean.optional(),

    /**
     * The second key to the same door, and the only thing that lets the sandbox
     * run under NODE_ENV=production.
     *
     * Defaults false and has no environment-dependent behaviour, so there is
     * exactly one way to reach a mock settlement in production: type this
     * variable's name, in full, on purpose.
     */
    PAYMENTS_ALLOW_MOCK_IN_PRODUCTION: EnvBoolean.default(false),
  })
  .refine((e) => e.AUTH_USER_SECRET !== e.AUTH_ADMIN_SECRET, {
    message: 'AUTH_USER_SECRET and AUTH_ADMIN_SECRET must be different values',
    path: ['AUTH_ADMIN_SECRET'],
  })
  /*
   * Resolved after validation because the default is a function of another
   * field, which a per-field `.default()` cannot express. Written as a
   * transform rather than left for `env()`'s callers to work out: a default
   * computed at each call site is a default that eventually differs between
   * call sites, and this one decides whether a paywall exists.
   */
  .transform((e) => ({
    ...e,
    PAYMENTS_MOCK_ENABLED: e.PAYMENTS_MOCK_ENABLED ?? e.NODE_ENV === 'development',
  }))

export type Env = z.infer<typeof EnvSchema>

let cached: Env | null = null

export function env(): Env {
  if (cached) return cached

  const parsed = EnvSchema.safeParse(process.env)

  if (!parsed.success) {
    // Report every problem at once rather than one failed boot at a time.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`
    )
  }

  cached = parsed.data
  return cached
}

/** Test-only escape hatch so suites can swap configuration between cases. */
export function resetEnvCache(): void {
  cached = null
}
