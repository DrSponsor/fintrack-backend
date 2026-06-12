import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../errors/AppError'
import { ERROR_CODES } from '../errors/codes'
import { unauthenticated } from '../errors/factories'

export function requireSubscription(request: FastifyRequest, _reply: FastifyReply): void {
  if (request.user === undefined) {
    throw unauthenticated()
  }

  if (request.user.tier !== 'PRO') {
    throw new AppError(ERROR_CODES.FORBIDDEN, 'Pro subscription required', 402)
  }
}
