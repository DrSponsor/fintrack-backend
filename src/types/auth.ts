export type Role = 'user' | 'support' | 'admin'
export type Tier = 'FREE' | 'PRO'

export type AuthenticatedUser = {
  readonly sub: string
  readonly role: Role
  readonly tier: Tier
  readonly subscriptionExpiresAt?: string | undefined
}
