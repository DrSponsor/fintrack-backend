import type { PrismaClient } from '../../../generated/prisma/client'
import type { Tier, Role } from '../../../types/auth'

// ──────────────────────────────────────────────────────────────────
// Domain types — never expose Prisma model instances outside repos
// ──────────────────────────────────────────────────────────────────

export type UserRecord = {
  readonly id: string
  readonly email: string
  readonly passwordHash: string
  readonly tier: Tier
  readonly role: Role
  readonly createdAt: Date
}

export type CreateUserData = {
  readonly email: string
  readonly passwordHash: string
}

// ──────────────────────────────────────────────────────────────────
// Repository interface — swap implementation for testing
// ──────────────────────────────────────────────────────────────────

export interface IUserRepository {
  create(data: CreateUserData): Promise<UserRecord>
  findByEmail(email: string): Promise<UserRecord | null>
  findById(id: string): Promise<UserRecord | null>
  updateTier(userId: string, tier: 'FREE' | 'PRO'): Promise<void>
}

// ──────────────────────────────────────────────────────────────────
// Prisma implementation
// ──────────────────────────────────────────────────────────────────

export class PrismaUserRepository implements IUserRepository {
  private readonly prisma: PrismaClient

  public constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  public async create(data: CreateUserData): Promise<UserRecord> {
    const user = await this.prisma.user.create({
      data: {
        email: data.email,
        passwordHash: data.passwordHash,
      },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        tier: true,
        createdAt: true,
      },
    })

    return {
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      tier: user.tier as Tier,
      role: 'user',
      createdAt: user.createdAt,
    }
  }

  public async findByEmail(email: string): Promise<UserRecord | null> {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        tier: true,
        createdAt: true,
      },
    })

    if (user === null) {
      return null
    }

    return {
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      tier: user.tier as Tier,
      role: 'user',
      createdAt: user.createdAt,
    }
  }

  public async findById(id: string): Promise<UserRecord | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        tier: true,
        createdAt: true,
      },
    })

    if (user === null) {
      return null
    }

    return {
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      tier: user.tier as Tier,
      role: 'user',
      createdAt: user.createdAt,
    }
  }

  public async updateTier(userId: string, tier: 'FREE' | 'PRO'): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { tier },
    })
  }
}
