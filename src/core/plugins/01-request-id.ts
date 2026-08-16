import fp from 'fastify-plugin'
import type { AppFastifyInstance, AppFastifyPluginCallback } from '../../types/fastify'

export const requestIdPlugin: AppFastifyPluginCallback = fp((fastify: AppFastifyInstance, _options, done) => {
  fastify.decorateRequest('requestId', '')

  fastify.addHook('onRequest', (request, reply, hookDone) => {
    request.requestId = request.id
    reply.header('x-request-id', request.id)
    hookDone()
  })
  done()
}, {
  name: '01-request-id',
})
