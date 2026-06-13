import { describe, expect, it } from 'vitest'
import { hasPermission } from '../src/types/auth'
import type { Permission } from '../src/types/auth'

describe('RBAC hasPermission', () => {
  describe('user role', () => {
    it('grants own-scoped transaction read', () => {
      expect(hasPermission('user', 'transactions:own:read')).toBe(true)
    })

    it('grants own-scoped transaction create via wildcard action', () => {
      expect(hasPermission('user', 'transactions:own:create')).toBe(true)
    })

    it('grants own-scoped account delete via wildcard action', () => {
      expect(hasPermission('user', 'accounts:own:delete')).toBe(true)
    })

    it('denies any-scoped transaction read', () => {
      expect(hasPermission('user', 'transactions:any:read')).toBe(false)
    })

    it('denies any-scoped user read', () => {
      expect(hasPermission('user', 'users:any:read')).toBe(false)
    })

    it('denies unregistered resource', () => {
      expect(hasPermission('user', 'admin-panel:own:read' as Permission)).toBe(false)
    })
  })

  describe('support role', () => {
    it('inherits user own-scoped permissions', () => {
      expect(hasPermission('support', 'transactions:own:read')).toBe(true)
      expect(hasPermission('support', 'budgets:own:create')).toBe(true)
    })

    it('grants any-scoped transaction read', () => {
      expect(hasPermission('support', 'transactions:any:read')).toBe(true)
    })

    it('grants any-scoped user read', () => {
      expect(hasPermission('support', 'users:any:read')).toBe(true)
    })

    it('denies any-scoped user delete (support cannot delete users)', () => {
      expect(hasPermission('support', 'users:any:delete')).toBe(false)
    })
  })

  describe('admin role', () => {
    it('grants any permission via wildcard', () => {
      expect(hasPermission('admin', 'transactions:any:delete')).toBe(true)
      expect(hasPermission('admin', 'users:any:delete')).toBe(true)
      expect(hasPermission('admin', 'dangerous:any:nuke' as Permission)).toBe(true)
    })

    it('inherits all user and support permissions', () => {
      expect(hasPermission('admin', 'transactions:own:read')).toBe(true)
      expect(hasPermission('admin', 'budgets:own:create')).toBe(true)
      expect(hasPermission('admin', 'users:any:read')).toBe(true)
    })
  })
})
