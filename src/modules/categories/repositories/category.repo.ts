import type { PrismaClient } from '../../../generated/prisma/client'

export type CategoryRecord = {
  readonly id: string
  readonly name: string
  readonly icon: string
}

export interface ICategoryRepository {
  findAll(): Promise<readonly CategoryRecord[]>
  findById(id: string): Promise<CategoryRecord | null>
  /** Seeded categories are addressed by their stable name — 'transfers',
   *  'uncategorised' — where an id would be an unreadable constant. */
  findByName(name: string): Promise<CategoryRecord | null>
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

  public async findByName(name: string): Promise<CategoryRecord | null> {
    return this.prisma.category.findUnique({
      where: { name },
      select: { id: true, name: true, icon: true },
    })
  }
}
