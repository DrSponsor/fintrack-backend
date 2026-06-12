import type { FastifyReply, FastifyRequest } from 'fastify'
import { notFound, unauthenticated } from '../errors/factories'

export type OwnershipLoader = (resourceId: string) => Promise<{ readonly userId: string } | null>

export function ownership(
  paramName: string,
  loadResource: OwnershipLoader,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (request.user === undefined) {
      throw unauthenticated()
    }

    const params = request.params
    if (typeof params !== 'object' || params === null || !(paramName in params)) {
      throw notFound()
    }

    const value = (params as Record<string, unknown>)[paramName]
    if (typeof value !== 'string') {
      throw notFound()
    }

    const resource = await loadResource(value)
    if (resource === null || resource.userId !== request.user.sub) {
      throw notFound()
    }
  }
}
