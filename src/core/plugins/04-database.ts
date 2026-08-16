import fp from 'fastify-plugin'
import type { AppFastifyInstance } from '../../types/fastify'
import type { AppConfig } from '../../config'
import { createPrismaClients, disconnectDatabase } from '../../config/database'
import type { DatabaseClients } from '../../config/database'

export type DatabasePluginOptions = {
  readonly appConfig: AppConfig
  readonly clients?: DatabaseClients
}

export const databasePlugin = fp((fastify: AppFastifyInstance, options: DatabasePluginOptions, done) => {
  const clients = options.clients ?? createPrismaClients(options.appConfig)
  fastify.decorate('db', clients)

  fastify.addHook('onClose', async () => {
    await disconnectDatabase(clients)
  })
  done()
}, {
  name: '04-database',
})
