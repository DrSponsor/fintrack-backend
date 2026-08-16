import fp from 'fastify-plugin'
import type { AppFastifyPluginCallback } from '../../types/fastify'
import { registerUserRoutes } from './routes/user.routes'

const usersModule: AppFastifyPluginCallback = (fastify, _options, done) => {
  registerUserRoutes(fastify)
  done()
}

export const usersPlugin = fp(usersModule, {
  name: 'module-users',
  dependencies: ['04-database', '05-redis', '07-auth'],
})
