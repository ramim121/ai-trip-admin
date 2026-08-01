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
    AI_MODEL: z.string().default('gemini-2.5-flash'),
    GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),

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
