import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@/generated/prisma/client'
import { env } from './env'

/**
 * Prisma client singleton.
 *
 * Prisma 7 requires an explicit driver adapter for SQL providers, so the pg
 * pool is constructed here rather than inferred from the schema. Constructing
 * the pool does not open a connection — pg connects lazily on first query — so
 * this stays cheap even in routes that never touch the database.
 *
 * The instance hangs off `globalThis` because Next's dev server re-evaluates
 * modules on every hot reload; without this, each reload would leak a pool
 * until Postgres refused new connections.
 *
 * Access is proxied so that `env()` is not read at import time, keeping
 * `next build` working on machines without secrets.
 */

const globalForDb = globalThis as unknown as { __beyondBordersPrisma?: PrismaClient }

/**
 * Translate the URL's `sslmode` into what node-postgres expects.
 *
 * These two disagree, and the disagreement is why a managed Postgres refuses to
 * connect. In libpq — whose vocabulary `sslmode` belongs to — `require` means
 * "encrypt the connection, do NOT authenticate the server"; only `verify-ca` and
 * `verify-full` check the certificate chain. node-postgres instead treats any
 * TLS as verified TLS, so `?sslmode=require` against Supabase fails with
 * "self-signed certificate in certificate chain" — its chain is not in Node's
 * default trust store.
 *
 * Honouring libpq's meaning fixes that without inventing a policy: the caller
 * asked for encryption and got encryption. Anyone who wants the server
 * authenticated writes `verify-full`, which is the mode that means it, and can
 * point `NODE_EXTRA_CA_CERTS` at the provider's CA.
 *
 * Worth being plain about the tradeoff `require` carries over the public
 * internet: traffic is encrypted, so a passive observer learns nothing, but an
 * attacker able to redirect the connection could present their own certificate.
 * For a database reachable only from our own infrastructure that is an accepted
 * risk; for anything stricter, use `verify-full`.
 */
function connectionFor(rawUrl: string): {
  connectionString: string
  ssl: { rejectUnauthorized: boolean } | undefined
} {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    // A URL we cannot parse is one we must not echo — it carries the password.
    return { connectionString: rawUrl, ssl: undefined }
  }

  const mode = url.searchParams.get('sslmode')
  if (mode === null) return { connectionString: rawUrl, ssl: undefined }

  // Strip it. Left in the string, `pg-connection-string` derives its own `ssl`
  // from it and that derivation wins over the explicit option below, which is
  // precisely the override this function exists to make.
  url.searchParams.delete('sslmode')
  const connectionString = url.toString()

  if (mode === 'disable' || mode === 'allow' || mode === 'prefer') {
    return { connectionString, ssl: undefined }
  }

  if (mode === 'verify-ca' || mode === 'verify-full') {
    return { connectionString, ssl: { rejectUnauthorized: true } }
  }

  // `require`, and anything unrecognised, gets encryption without verification.
  return { connectionString, ssl: { rejectUnauthorized: false } }
}

/**
 * How many Postgres connections ONE instance of this process may hold.
 *
 * `pg` defaults to 10, which is right for a long-lived server handling many
 * requests at once and catastrophically wrong for a serverless function. A
 * Vercel function instance serves ONE request at a time, so nine of those ten
 * connections can never be used — but they are still claimed, and claimed
 * against a budget shared with every other warm instance.
 *
 * That arithmetic is what took production down on the first deploy: Supabase's
 * pooler in session mode allows 15 clients on the free tier, so a couple of warm
 * instances at the default exhausted it and every query afterwards failed with
 * `(EMAXCONNSESSION) max clients reached in session mode`.
 *
 * One connection per instance is therefore not a tuning choice, it is the shape
 * of the runtime. Concurrency comes from Vercel running more instances, and each
 * one needs exactly the single connection it is using.
 *
 * `idleTimeoutMillis` is short for the same reason: an instance frozen between
 * invocations should not sit on a connection somebody else could be using.
 * `connectionTimeoutMillis` makes exhaustion surface as a fast, legible error
 * rather than a request that hangs until the platform kills it.
 */
const POOL_LIMITS = {
  max: 1,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
} as const

function createClient(): PrismaClient {
  const config = env()
  const { connectionString, ssl } = connectionFor(config.DATABASE_URL)

  return new PrismaClient({
    // `ssl` is spread last so `connectionFor`'s decision still wins — see the
    // note there on why sslmode is stripped from the string first.
    adapter: new PrismaPg({ connectionString, ...POOL_LIMITS, ...(ssl ? { ssl } : {}) }),
    log: config.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

function client(): PrismaClient {
  globalForDb.__beyondBordersPrisma ??= createClient()
  return globalForDb.__beyondBordersPrisma
}

export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const instance = client()
    const value = Reflect.get(instance, property, instance)
    // Methods such as $transaction lose their receiver when handed out bare.
    return typeof value === 'function' ? value.bind(instance) : value
  },
})

/** Close the pool. For test teardown and scripts — route handlers should not call this. */
export async function disconnectDb(): Promise<void> {
  if (globalForDb.__beyondBordersPrisma) {
    await globalForDb.__beyondBordersPrisma.$disconnect()
    globalForDb.__beyondBordersPrisma = undefined
  }
}
