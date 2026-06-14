import fp from 'fastify-plugin'
import type { FastifyPluginCallback } from 'fastify'
import { registerTransactionRoutes } from './routes/transaction.routes'

const transactionsModule: FastifyPluginCallback = (fastify, _options, done) => {
  registerTransactionRoutes(fastify)
  done()
}

export const transactionsPlugin = fp(transactionsModule, {
  name: 'module-transactions',
  dependencies: ['04-database', '07-auth'],
})
