import { PrismaClient } from '../generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import type { AppConfig } from './index'

export type DatabaseClients = {
  readonly primary: PrismaClient
  readonly read: PrismaClient
}

export function createPrismaClients(appConfig: AppConfig): DatabaseClients {
  const primaryPool = new Pool({ connectionString: appConfig.databaseUrl })
  const primaryAdapter = new PrismaPg(primaryPool)
  const primary = new PrismaClient({ adapter: primaryAdapter })

  const readUrl = appConfig.readReplicaDatabaseUrl && appConfig.readReplicaDatabaseUrl.length > 0
    ? appConfig.readReplicaDatabaseUrl
    : appConfig.databaseUrl

  const readPool = new Pool({ connectionString: readUrl })
  const readAdapter = new PrismaPg(readPool)
  const read = new PrismaClient({ adapter: readAdapter })

  return { primary, read }
}

export async function checkDatabase(clients: DatabaseClients): Promise<void> {
  await clients.primary.$queryRaw`SELECT 1`
  await clients.read.$queryRaw`SELECT 1`
}

export async function disconnectDatabase(clients: DatabaseClients): Promise<void> {
  await Promise.all([clients.primary.$disconnect(), clients.read.$disconnect()])
}
