import type { FastifyReply, FastifyRequest } from 'fastify'
import { unauthenticated } from '../errors/factories'
import type { AuthenticatedUser } from '../../types/auth'

// Must stay `async` even though the body never awaits: Fastify's preHandler
// dispatch only recognizes a hook as complete via a returned thenable or a
// `done` callback. A plain synchronous 2-arg function that just returns
// `undefined` satisfies neither convention, and the request hangs forever
// (verified directly — switching this to a bare sync function reproduced a
// deterministic hang in every route that uses this as a preHandler).
// eslint-disable-next-line @typescript-eslint/require-await
export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  requireUser(request)
}

/**
 * Narrows `request.user` from optional to required, throwing the same
 * 401 `authenticate` would if it's somehow missing. Route handlers call
 * this instead of asserting `request.user!` — every route that reaches
 * here already ran `authenticate` as a preHandler, but Fastify's hook
 * typing can't express that guarantee to the type checker.
 */
export function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (request.user === undefined) {
    throw unauthenticated()
  }
  return request.user
}
