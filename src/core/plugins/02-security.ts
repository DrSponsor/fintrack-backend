import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import fp from 'fastify-plugin'
import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { AppConfig } from '../../config'
import { AppError } from '../errors/AppError'
import { ERROR_CODES } from '../errors/codes'

export type SecurityPluginOptions = {
  readonly appConfig: AppConfig
}

const methodsWithBody = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export const securityPlugin = fp(async (fastify: FastifyInstance<any, any, any, any, any>, options: SecurityPluginOptions) => {
  await fastify.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
  })

  await fastify.register(cors, {
    origin: options.appConfig.corsOrigins.length === 0 ? false : [...options.appConfig.corsOrigins],
    credentials: true,
  })

  fastify.addHook('onRequest', (request, _reply, done) => {
    if (!methodsWithBody.has(request.method)) {
      done()
      return
    }

    const contentLength = request.headers['content-length']
    const hasBody = typeof contentLength === 'string' && contentLength !== '0'
    if (!hasBody) {
      done()
      return
    }

    const contentType = request.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('application/json')) {
      throw new AppError(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, 'Content-Type must be application/json', 415)
    }
    done()
  })
}, {
  name: '02-security',
})
