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

function createClient(): PrismaClient {
  const config = env()
  const { connectionString, ssl } = connectionFor(config.DATABASE_URL)

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, ...(ssl ? { ssl } : {}) }),
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
