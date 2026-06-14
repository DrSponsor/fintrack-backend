import type { PrismaClient } from '../../../generated/prisma/client'

export type CategoryRecord = {
  readonly id: string
  readonly name: string
  readonly icon: string
}

export interface ICategoryRepository {
  findAll(): Promise<readonly CategoryRecord[]>
  findById(id: string): Promise<CategoryRecord | null>
}

export class PrismaCategoryRepository implements ICategoryRepository {
  private readonly prisma: PrismaClient

  public constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  public async findAll(): Promise<readonly CategoryRecord[]> {
    return this.prisma.category.findMany({
      select: { id: true, name: true, icon: true },
      orderBy: { name: 'asc' },
    })
  }

  public async findById(id: string): Promise<CategoryRecord | null> {
    return this.prisma.category.findUnique({
      where: { id },
      select: { id: true, name: true, icon: true },
    })
  }
}
