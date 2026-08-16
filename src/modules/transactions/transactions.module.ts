import fp from 'fastify-plugin'
import type { AppFastifyPluginCallback } from '../../types/fastify'
import { registerTransactionRoutes } from './routes/transaction.routes'

const transactionsModule: AppFastifyPluginCallback = (fastify, _options, done) => {
  registerTransactionRoutes(fastify)
  done()
}

export const transactionsPlugin = fp(transactionsModule, {
  name: 'module-transactions',
  dependencies: ['04-database', '07-auth'],
})
