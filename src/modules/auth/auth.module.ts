import fp from 'fastify-plugin'
import type { AppFastifyPluginCallback } from '../../types/fastify'
import { registerAuthRoutes } from './routes/auth.routes'

/**
 * Auth module — single entry point.
 *
 * Other modules import from this file and nothing else.
 * Internals (use cases, repositories, schemas) are not exposed.
 */
const authModule: AppFastifyPluginCallback = (fastify, _options, done) => {
  registerAuthRoutes(fastify)
  done()
}

export const authPlugin = fp(authModule, {
  name: 'module-auth',
  dependencies: ['04-database', '05-redis', '07-auth'],
})
