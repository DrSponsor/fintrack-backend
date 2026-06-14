import fp from 'fastify-plugin'
import type { FastifyPluginCallback } from 'fastify'
import { registerCategoryRoutes } from './routes/category.routes'

const categoriesModule: FastifyPluginCallback = (fastify, _options, done) => {
  registerCategoryRoutes(fastify)
  done()
}

export const categoriesPlugin = fp(categoriesModule, {
  name: 'module-categories',
  dependencies: ['04-database'],
})
