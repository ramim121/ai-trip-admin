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

function createClient(): PrismaClient {
  const config = env()

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: config.DATABASE_URL }),
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
