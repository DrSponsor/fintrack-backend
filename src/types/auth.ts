// ──────────────────────────────────────────────────────────────────
// Core Identity Types
// ──────────────────────────────────────────────────────────────────

export type Role = 'user' | 'support' | 'admin'
export type Tier = 'FREE' | 'PRO'

/**
 * The authenticated user payload extracted from a verified JWT.
 * Populated on `request.user` by the `07-auth.ts` plugin.
 */
export type AuthenticatedUser = {
  readonly sub: string
  readonly email: string
  readonly role: Role
  readonly tier: Tier
  readonly sid?: string | undefined
  readonly subscriptionExpiresAt?: string | undefined
}

// ──────────────────────────────────────────────────────────────────
// RBAC Permission System
// ──────────────────────────────────────────────────────────────────

/**
 * Permission string format: `resource:scope:action`
 *
 * Scopes:
 *   - `own`  — user can only act on their own resources
 *   - `any`  — user can act on any user's resources (support/admin)
 *
 * Actions:
 *   - `read`, `create`, `update`, `delete`
 *   - `*` — wildcard, grants all actions
 */
export type Permission = `${string}:${'own' | 'any'}:${'read' | 'create' | 'update' | 'delete' | '*'}`

/**
 * Static RBAC permission grants per role.
 * Evaluated by the `authorize` middleware.
 *
 * Convention: higher roles inherit lower role permissions at runtime.
 * The `admin` role has a wildcard `*:any:*` — bypasses all checks.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  user: [
    'transactions:own:*',
    'accounts:own:*',
    'budgets:own:*',
    'categories:own:read',
    'analysis:own:read',
    'users:own:read',
    'users:own:update',
    'users:own:delete',
    'billing:own:*',
  ],
  support: [
    // Support inherits all `user` permissions at runtime.
    'transactions:any:read',
    'users:any:read',
    'accounts:any:read',
  ],
  admin: [
    // Admin bypasses permission checks entirely via wildcard.
    '*:any:*' as Permission,
  ],
} as const

/**
 * Checks whether a role's permission set grants a specific permission.
 * Supports wildcard matching on resource, scope, and action segments.
 *
 * Role inheritance: admin > support > user.
 * Higher roles accumulate permissions from lower roles.
 */
export function hasPermission(role: Role, required: Permission): boolean {
  const grants = getEffectivePermissions(role)

  const [reqResource, reqScope, reqAction] = required.split(':') as [string, string, string]

  for (const grant of grants) {
    const [gResource, gScope, gAction] = grant.split(':') as [string, string, string]

    const resourceMatch = gResource === '*' || gResource === reqResource
    const scopeMatch = gScope === 'any' || gScope === reqScope
    const actionMatch = gAction === '*' || gAction === reqAction

    if (resourceMatch && scopeMatch && actionMatch) {
      return true
    }
  }

  return false
}

/**
 * Returns the accumulated permission set for a role,
 * including inherited permissions from lower roles.
 */
function getEffectivePermissions(role: Role): readonly Permission[] {
  switch (role) {
    case 'admin':
      return [
        ...ROLE_PERMISSIONS.user,
        ...ROLE_PERMISSIONS.support,
        ...ROLE_PERMISSIONS.admin,
      ]
    case 'support':
      return [
        ...ROLE_PERMISSIONS.user,
        ...ROLE_PERMISSIONS.support,
      ]
    case 'user':
      return ROLE_PERMISSIONS.user
  }
}
