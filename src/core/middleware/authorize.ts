import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Permission } from '../../types/auth'
import { hasPermission } from '../../types/auth'
import { forbidden, unauthenticated } from '../errors/factories'

/**
 * RBAC authorization middleware factory.
 *
 * Usage in route registration:
 *   preHandler: [authenticate, authorize('transactions:own:read')]
 *
 * Permission format: `resource:scope:action`
 *   - resource: the module name (transactions, accounts, budgets, etc.)
 *   - scope: `own` (user's resources only) or `any` (cross-user, support/admin)
 *   - action: `read`, `create`, `update`, `delete`, or `*` (wildcard)
 *
 * Role inheritance is handled by `hasPermission`:
 *   admin > support > user
 *
 * The authorize middleware MUST run after authenticate — it requires
 * `request.user` to be populated. Plugin ordering enforces this:
 * `07-auth.ts` runs before any route preHandler.
 */
export function authorize(
  requiredPermission: Permission,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (request.user === undefined) {
      throw unauthenticated()
    }

    if (!hasPermission(request.user.role, requiredPermission)) {
      throw forbidden()
    }
  }
}
