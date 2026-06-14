import type { PrismaClient } from '../../../generated/prisma/client'
import type { AccountType, CaptureMethod } from '../../../generated/prisma/enums'

// ──────────────────────────────────────────────────────────────────
// Domain types — BigInt fields arrive as bigint from Prisma.
// We convert to string at the repo boundary for JSON safety.
// ──────────────────────────────────────────────────────────────────

export type AccountRecord = {
  readonly id: string
  readonly userId: string
  readonly bankName: string
  readonly accountLast4: string
  readonly accountType: string
  readonly captureMethod: string
  readonly gmailConnected: boolean
  readonly balanceKobo: string
  readonly lastTransactionDate: Date | null
}

export type CreateAccountData = {
  readonly userId: string
  readonly bankName: string
  readonly accountLast4: string
  readonly accountType: AccountType
  readonly captureMethod: CaptureMethod
}

export type UpdateAccountData = {
  readonly bankName?: string | undefined
  readonly accountType?: AccountType | undefined
}

// ──────────────────────────────────────────────────────────────────
// Repository interface
// ──────────────────────────────────────────────────────────────────

export interface IAccountRepository {
  create(data: CreateAccountData): Promise<AccountRecord>
  findByUserId(userId: string): Promise<readonly AccountRecord[]>
  findById(id: string): Promise<AccountRecord | null>
  update(id: string, data: UpdateAccountData): Promise<AccountRecord>
  delete(id: string): Promise<void>
  countByUserId(userId: string): Promise<number>
  updateGmailToken(id: string, gmailTokenEnc: string | null, gmailConnected: boolean): Promise<AccountRecord>
  getGmailToken(id: string): Promise<string | null>
  findConnectedGmailAccounts(): Promise<readonly AccountRecord[]>
}

// ──────────────────────────────────────────────────────────────────
// Prisma implementation
// ──────────────────────────────────────────────────────────────────

const SELECT_FIELDS = {
  id: true,
  userId: true,
  bankName: true,
  accountLast4: true,
  accountType: true,
  captureMethod: true,
  gmailConnected: true,
  balanceKobo: true,
  lastTransactionDate: true,
} as const

type PrismaAccountRow = {
  id: string
  userId: string
  bankName: string
  accountLast4: string
  accountType: string
  captureMethod: string
  gmailConnected: boolean
  balanceKobo: bigint
  lastTransactionDate: Date | null
}

function toDomain(row: PrismaAccountRow): AccountRecord {
  return {
    id: row.id,
    userId: row.userId,
    bankName: row.bankName,
    accountLast4: row.accountLast4,
    accountType: row.accountType,
    captureMethod: row.captureMethod,
    gmailConnected: row.gmailConnected,
    balanceKobo: row.balanceKobo.toString(),
    lastTransactionDate: row.lastTransactionDate,
  }
}

export class PrismaAccountRepository implements IAccountRepository {
  private readonly prisma: PrismaClient

  public constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  public async create(data: CreateAccountData): Promise<AccountRecord> {
    const row = await this.prisma.account.create({
      data: {
        userId: data.userId,
        bankName: data.bankName,
        accountLast4: data.accountLast4,
        accountType: data.accountType,
        captureMethod: data.captureMethod,
      },
      select: SELECT_FIELDS,
    })

    return toDomain(row as unknown as PrismaAccountRow)
  }

  public async findByUserId(userId: string): Promise<readonly AccountRecord[]> {
    const rows = await this.prisma.account.findMany({
      where: { userId },
      select: SELECT_FIELDS,
      orderBy: { bankName: 'asc' },
    })

    return rows.map((row) => toDomain(row as unknown as PrismaAccountRow))
  }

  public async findById(id: string): Promise<AccountRecord | null> {
    const row = await this.prisma.account.findUnique({
      where: { id },
      select: SELECT_FIELDS,
    })

    if (row === null) {
      return null
    }

    return toDomain(row as unknown as PrismaAccountRow)
  }

  public async update(id: string, data: UpdateAccountData): Promise<AccountRecord> {
    const row = await this.prisma.account.update({
      where: { id },
      data: {
        ...(data.bankName !== undefined ? { bankName: data.bankName } : {}),
        ...(data.accountType !== undefined ? { accountType: data.accountType } : {}),
      },
      select: SELECT_FIELDS,
    })

    return toDomain(row as unknown as PrismaAccountRow)
  }

  public async delete(id: string): Promise<void> {
    await this.prisma.account.delete({ where: { id } })
  }

  public async countByUserId(userId: string): Promise<number> {
    return this.prisma.account.count({ where: { userId } })
  }

  public async updateGmailToken(id: string, gmailTokenEnc: string | null, gmailConnected: boolean): Promise<AccountRecord> {
    const row = await this.prisma.account.update({
      where: { id },
      data: {
        gmailTokenEnc,
        gmailConnected,
      },
      select: SELECT_FIELDS,
    })

    return toDomain(row as unknown as PrismaAccountRow)
  }

  public async getGmailToken(id: string): Promise<string | null> {
    const row = await this.prisma.account.findUnique({
      where: { id },
      select: { gmailTokenEnc: true },
    })

    return row?.gmailTokenEnc ?? null
  }

  public async findConnectedGmailAccounts(): Promise<readonly AccountRecord[]> {
    const rows = await this.prisma.account.findMany({
      where: { gmailConnected: true },
      select: SELECT_FIELDS,
    })

    return rows.map((row) => toDomain(row as unknown as PrismaAccountRow))
  }
}
