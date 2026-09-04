import { PrismaClient } from '../generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import type { AppConfig } from './index'

export type DatabaseClients = {
  readonly primary: PrismaClient
  readonly read: PrismaClient
}

/**
 * How many connections each pool may open.
 *
 * node-postgres defaults to 10, and this used to build TWO pools — so a
 * single instance could hold twenty connections open. That is survivable
 * against a Postgres you own and is not against a shared pooler: Supabase’s
 * free tier allows far fewer, and exhausting them fails every request rather
 * than slowing them down.
 *
 * Five is ample for a Fastify process, which multiplexes requests over a
 * handful of connections. Override for a bigger instance.
 */
const POOL_MAX = Number(process.env.DATABASE_POOL_MAX ?? 5)

export function createPrismaClients(appConfig: AppConfig): DatabaseClients {
  const primaryPool = new Pool({ connectionString: appConfig.databaseUrl, max: POOL_MAX })
  const primary = new PrismaClient({ adapter: new PrismaPg(primaryPool) })

  const readUrl =
    appConfig.readReplicaDatabaseUrl && appConfig.readReplicaDatabaseUrl.length > 0
      ? appConfig.readReplicaDatabaseUrl
      : appConfig.databaseUrl

  // With no replica configured, the read URL IS the primary URL, and opening a
  // second pool to the same database doubles the connection count for no
  // benefit whatsoever. Reads and writes then share one client, which is
  // exactly what a single-database deployment wants.
  if (readUrl === appConfig.databaseUrl) {
    return { primary, read: primary }
  }

  const readPool = new Pool({ connectionString: readUrl, max: POOL_MAX })
  const read = new PrismaClient({ adapter: new PrismaPg(readPool) })

  return { primary, read }
}

export async function checkDatabase(clients: DatabaseClients): Promise<void> {
  await clients.primary.$queryRaw`SELECT 1`
  // Skipped when they are the same client, which they are unless a replica is
  // configured. Checking twice would only prove the same connection twice.
  if (clients.read !== clients.primary) {
    await clients.read.$queryRaw`SELECT 1`
  }
}

export async function disconnectDatabase(clients: DatabaseClients): Promise<void> {
  const unique =
    clients.read === clients.primary ? [clients.primary] : [clients.primary, clients.read]
  await Promise.all(unique.map((client) => client.$disconnect()))
}
