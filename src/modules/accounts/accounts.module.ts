import fp from 'fastify-plugin'
import type { FastifyPluginCallback } from 'fastify'
import { registerAccountRoutes } from './routes/account.routes'

const accountsModule: FastifyPluginCallback = (fastify, _options, done) => {
  registerAccountRoutes(fastify)
  done()
}

export const accountsPlugin = fp(accountsModule, {
  name: 'module-accounts',
  dependencies: ['04-database', '07-auth'],
})
