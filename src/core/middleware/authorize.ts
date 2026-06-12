import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Role } from '../../types/auth'
import { forbidden, unauthenticated } from '../errors/factories'

const roleRank: Record<Role, number> = {
  user: 1,
  support: 2,
  admin: 3,
}

export function authorize(requiredRole: Role): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (request.user === undefined) {
      throw unauthenticated()
    }
    if (roleRank[request.user.role] < roleRank[requiredRole]) {
      throw forbidden()
    }
    return Promise.resolve()
  }
}
