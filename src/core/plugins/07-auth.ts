import fp from 'fastify-plugin'
import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import type { AppConfig } from '../../config'
import { verifyAccessToken } from '../crypto/tokens'
import { unauthenticated } from '../errors/factories'

export type AuthPluginOptions = {
  readonly appConfig: AppConfig
}

function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined) {
    return null
  }

  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined || token.length === 0) {
    return null
  }

  return token
}

export const authPlugin = fp((fastify: FastifyInstance<any, any, any, any, any>, options: AuthPluginOptions, done) => {
  fastify.decorateRequest('user')

  fastify.addHook('preHandler', async (request) => {
    const token = extractBearerToken(request.headers.authorization)
    if (token === null) {
      return
    }

    if (options.appConfig.jwtPublicKeyPem === undefined) {
      throw unauthenticated('JWT verifier is not configured')
    }

    try {
      request.user = await verifyAccessToken(token, options.appConfig.jwtPublicKeyPem)
    } catch (error) {
      request.log.warn({ err: error }, 'access token verification failed')
      throw unauthenticated('Invalid access token')
    }
  })
  done()
}, {
  name: '07-auth',
  dependencies: ['05-redis'],
})
