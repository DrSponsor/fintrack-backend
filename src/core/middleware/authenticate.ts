import type { FastifyReply, FastifyRequest } from 'fastify'
import { unauthenticated } from '../errors/factories'

export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (request.user === undefined) {
    throw unauthenticated()
  }
}
