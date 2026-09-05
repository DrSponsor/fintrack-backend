import fp from 'fastify-plugin'
import type { AppFastifyInstance } from '../../types/fastify'
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

export const authPlugin = fp((fastify: AppFastifyInstance, options: AuthPluginOptions, done) => {
  fastify.decorateRequest('user')

  fastify.addHook('preHandler', async (request) => {
    const token = extractBearerToken(request.headers.authorization)
    if (token === null) {
      return
    }

    if (options.appConfig.jwtPublicKeyPem === undefined) {
      throw unauthenticated('JWT verifier is not configured')
    }

    // A token that does not verify leaves `request.user` undefined — the same
    // state as sending no token at all — rather than failing the request here.
    //
    // This hook is global: it runs before EVERY route, including the public
    // ones. Throwing meant a client holding an expired token could not reach
    // an unauthenticated endpoint at all, which is what made POST
    // /v1/auth/refresh unreachable — clients attach the access token to every
    // request, so the expired token they were trying to replace was itself
    // what got the refresh rejected. Sessions ended 15 minutes after sign-in.
    //
    // Enforcement is unchanged and still total. This hook only ever
    // POPULATES; `authenticate` is what REQUIRES, and it is the preHandler on
    // 35 of the server's 36 guarded routes (the exception being refresh, by
    // design). `authorize`, `ownership` and `requireSubscription` each throw
    // on an undefined user independently. An unverifiable token therefore
    // still cannot reach anything a missing one could not.
    try {
      request.user = await verifyAccessToken(token, options.appConfig.jwtPublicKeyPem)
    } catch (error) {
      request.log.warn(
        { err: error },
        'access token verification failed — treating request as unauthenticated',
      )
    }
  })
  done()
}, {
  name: '07-auth',
  dependencies: ['05-redis'],
})
