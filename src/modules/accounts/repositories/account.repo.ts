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
  readonly accountLast4: string | null
  /** The bank's own masked number, when the account was discovered. */
  readonly accountMask: string | null
  readonly holderName: string | null
  readonly verificationSource: 'SELF_DECLARED' | 'EMAIL_DISCOVERY'
  readonly accountType: string
  readonly captureMethod: string
  readonly gmailConnected: boolean
  readonly balanceKobo: string
  /** Net movement since the bank last stated the balance above. Kept apart
   *  from it because one is what a bank said and the other is what this app
   *  worked out, and a screen has to be able to tell a person which is which. */
  readonly adjustmentKobo: string
  /** How many transactions this account holds. Deleting it removes them all,
   *  so the number belongs in the warning rather than a vague “cannot be
   *  undone”. */
  readonly transactionCount: number
  readonly lastTransactionDate: Date | null
}

export type CreateAccountData = {
  readonly userId: string
  readonly bankName: string
  readonly accountLast4: string | null
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
  accountMask: true,
  holderName: true,
  verificationSource: true,
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
  accountLast4: string | null
  accountMask: string | null
  holderName: string | null
  verificationSource: 'SELF_DECLARED' | 'EMAIL_DISCOVERY'
  accountType: string
  captureMethod: string
  gmailConnected: boolean
  balanceKobo: bigint
  lastTransactionDate: Date | null
}

function toDomain(row: PrismaAccountRow, adjustmentKobo = 0n, transactionCount = 0): AccountRecord {
  return {
    id: row.id,
    userId: row.userId,
    bankName: row.bankName,
    accountLast4: row.accountLast4,
    accountMask: row.accountMask,
    holderName: row.holderName,
    verificationSource: row.verificationSource,
    accountType: row.accountType,
    captureMethod: row.captureMethod,
    gmailConnected: row.gmailConnected,
    balanceKobo: row.balanceKobo.toString(),
    adjustmentKobo: adjustmentKobo.toString(),
    transactionCount,
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

    return toDomain(row)
  }

  public async findByUserId(userId: string): Promise<readonly AccountRecord[]> {
    const rows = await this.prisma.account.findMany({
      where: { userId },
      select: SELECT_FIELDS,
      orderBy: { bankName: 'asc' },
    })

    // What has moved since each bank last stated a figure. Grouped in one
    // query rather than per account: this runs on every dashboard load, and a
    // query per account turns a fast screen into N round trips as soon as
    // somebody connects a second bank.
    const movements = await this.prisma.transaction.groupBy({
      by: ['accountId', 'type'],
      where: {
        OR: rows.map((row) => ({
          accountId: row.id,
          // A transaction ON the anchor is the anchor: the bank stated the
          // balance AFTER it, so counting it again would double it.
          transactionDate: { gt: row.lastTransactionDate ?? new Date(0) },
        })),
      },
      _sum: { amountKobo: true },
    })

    // Everything the account holds, not just what is unaccounted for.
    // Deleting an account cascades to its transactions, and a warning that
    // says “this also removes 39 entries” is a decision someone can make;
    // “this cannot be undone” is a phrase people click past.
    const totals = await this.prisma.transaction.groupBy({
      by: ['accountId'],
      where: { accountId: { in: rows.map((row) => row.id) } },
      _count: { _all: true },
    })
    const counts = new Map(totals.map((t) => [t.accountId, t._count._all]))

    const adjustments = new Map<string, bigint>()
    for (const group of movements) {
      const amount = group._sum.amountKobo ?? 0n
      const signed = group.type === 'CREDIT' ? amount : -amount
      adjustments.set(group.accountId, (adjustments.get(group.accountId) ?? 0n) + signed)
    }

    return rows.map((row) => toDomain(row, adjustments.get(row.id) ?? 0n, counts.get(row.id) ?? 0))
  }

  public async findById(id: string): Promise<AccountRecord | null> {
    const row = await this.prisma.account.findUnique({
      where: { id },
      select: SELECT_FIELDS,
    })

    if (row === null) {
      return null
    }

    return toDomain(row)
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

    return toDomain(row)
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

    return toDomain(row)
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

    return rows.map((row) => toDomain(row))
  }
}
