import type { FastifyReply, FastifyRequest } from 'fastify'
import { unauthenticated } from '../errors/factories'

export function authenticate(request: FastifyRequest, _reply: FastifyReply): void {
  if (request.user === undefined) {
    throw unauthenticated()
  }
}
