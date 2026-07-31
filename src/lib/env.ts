import { z } from 'zod'

/**
 * Validated server environment.
 *
 * Parsing is lazy and cached: reading `process.env` at module load would make
 * `next build` fail on machines that legitimately have no secrets, since Next
 * evaluates route modules during the build. The first actual access validates.
 */

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
  })
  .refine((e) => e.AUTH_USER_SECRET !== e.AUTH_ADMIN_SECRET, {
    message: 'AUTH_USER_SECRET and AUTH_ADMIN_SECRET must be different values',
    path: ['AUTH_ADMIN_SECRET'],
  })

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
