import fp from 'fastify-plugin'
import type { AppFastifyPluginCallback } from '../../types/fastify'
import { registerAccountRoutes } from './routes/account.routes'

const accountsModule: AppFastifyPluginCallback = (fastify, _options, done) => {
  registerAccountRoutes(fastify)
  done()
}

export const accountsPlugin = fp(accountsModule, {
  name: 'module-accounts',
  dependencies: ['04-database', '07-auth'],
})
