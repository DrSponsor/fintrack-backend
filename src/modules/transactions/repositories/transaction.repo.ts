import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../../generated/prisma/client'
import { sha256Hex } from '../../../core/crypto/hashing'
import type { TransactionType, CaptureSource } from '../../../generated/prisma/enums'

export type TransactionRecord = {
  readonly id: string
  readonly accountId: string
  readonly userId: string
  readonly amountKobo: string
  readonly type: 'DEBIT' | 'CREDIT'
  readonly merchantName: string
  readonly categoryId: string
  readonly transactionDate: Date
  readonly source: 'EMAIL' | 'MANUAL' | 'SMS' | 'MONO'
  readonly isVerified: boolean
  readonly createdAt: Date
}

export type CreateTransactionData = {
  readonly accountId: string
  readonly amountKobo: bigint
  readonly type: 'DEBIT' | 'CREDIT'
  readonly merchantName: string
  readonly categoryId: string
  readonly transactionDate: Date
  readonly source: 'EMAIL' | 'MANUAL' | 'SMS' | 'MONO'
  readonly idempotencyKey: string
  readonly balanceAfterKobo?: bigint | undefined
  readonly isVerified?: boolean
}

export type ListTransactionsFilter = {
  readonly accountId?: string
  readonly categoryId?: string
  readonly type?: 'DEBIT' | 'CREDIT'
  readonly startDate?: Date
  readonly endDate?: Date
}

export interface ITransactionRepository {
  create(data: CreateTransactionData): Promise<TransactionRecord>
  findById(id: string): Promise<TransactionRecord | null>
  findByUser(
    userId: string,
    cursor?: string,
    limit?: number,
    filters?: ListTransactionsFilter,
  ): Promise<{ readonly data: readonly TransactionRecord[]; readonly hasMore: boolean }>
  /**
   * Applies a category correction.
   *
   * Returns how many EARLIER transactions were backfilled, so the caller can
   * tell the user what actually happened rather than claiming a silent rewrite
   * of their history.
   */
  correctCategory(
    id: string,
    categoryId: string,
    userId: string,
    fingerprint: string,
    scope: CorrectionScope,
  ): Promise<number>
}

/** See correctCategoryBodySchema for why a correction has a reach at all. */
export type CorrectionScope = 'transaction' | 'merchant'

const SELECT_FIELDS = {
  id: true,
  accountId: true,
  amountKobo: true,
  type: true,
  merchantName: true,
  categoryId: true,
  transactionDate: true,
  source: true,
  isVerified: true,
  createdAt: true,
  account: {
    select: {
      userId: true,
    },
  },
} as const

type PrismaTransactionRow = {
  id: string
  accountId: string
  amountKobo: bigint
  type: TransactionType
  merchantName: string
  categoryId: string
  transactionDate: Date
  source: CaptureSource
  isVerified: boolean
  createdAt: Date
  account: {
    userId: string
  }
}

function toDomain(row: PrismaTransactionRow): TransactionRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    userId: row.account.userId,
    amountKobo: row.amountKobo.toString(),
    type: row.type,
    merchantName: row.merchantName,
    categoryId: row.categoryId,
    transactionDate: row.transactionDate,
    source: row.source,
    isVerified: row.isVerified,
    createdAt: row.createdAt,
  }
}

export class PrismaTransactionRepository implements ITransactionRepository {
  private readonly prisma: PrismaClient

  public constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  public async create(data: CreateTransactionData): Promise<TransactionRecord> {
    const account = await this.prisma.account.findUniqueOrThrow({
      where: { id: data.accountId },
      select: { userId: true },
    })

    const transactionId = randomUUID()
    const eventId = randomUUID()
    const eventTimestamp = new Date()
    const previousHash = '0'

    const eventPayload = {
      accountId: data.accountId,
      amountKobo: data.amountKobo.toString(),
      type: data.type,
      merchantName: data.merchantName,
      categoryId: data.categoryId,
      transactionDate: data.transactionDate.toISOString(),
      source: data.source,
    }

    const eventHash = sha256Hex(
      `${eventId}:CREATED:${JSON.stringify(eventPayload)}:${eventTimestamp.toISOString()}:${previousHash}`,
    )

    const balanceUpdateOps =
      data.balanceAfterKobo !== undefined
        ? [
            this.prisma.account.updateMany({
              where: {
                id: data.accountId,
                OR: [
                  { lastTransactionDate: null },
                  { lastTransactionDate: { lt: data.transactionDate } },
                ],
              },
              data: {
                balanceKobo: data.balanceAfterKobo,
                lastTransactionDate: data.transactionDate,
              },
            }),
          ]
        : []

    const [txRow] = await this.prisma.$transaction([
      this.prisma.transaction.create({
        data: {
          id: transactionId,
          accountId: data.accountId,
          amountKobo: data.amountKobo,
          type: data.type,
          merchantName: data.merchantName,
          categoryId: data.categoryId,
          transactionDate: data.transactionDate,
          source: data.source,
          idempotencyKey: data.idempotencyKey,
          isVerified: data.isVerified ?? false,
        },
        select: SELECT_FIELDS,
      }),
      this.prisma.transactionEvent.create({
        data: {
          id: eventId,
          transactionId,
          transactionDate: data.transactionDate,
          type: 'CREATED',
          payload: eventPayload,
          previousHash,
          hash: eventHash,
          createdAt: eventTimestamp,
        },
      }),
      ...balanceUpdateOps,
      this.prisma.outboxEvent.create({
        data: {
          eventType: 'transaction.created',
          payload: {
            transactionId,
            userId: account.userId,
            accountId: data.accountId,
            amountKobo: data.amountKobo.toString(),
            categoryId: data.categoryId,
          },
        },
      }),
    ])

    return toDomain(txRow)
  }

  public async findById(id: string): Promise<TransactionRecord | null> {
    const row = await this.prisma.transaction.findFirst({
      where: { id },
      select: SELECT_FIELDS,
    })

    if (row === null) {
      return null
    }

    return toDomain(row)
  }

  public async findByUser(
    userId: string,
    cursor?: string,
    limit = 20,
    filters?: ListTransactionsFilter,
  ): Promise<{ readonly data: readonly TransactionRecord[]; readonly hasMore: boolean }> {
    const whereClause = {
      account: { userId },
      ...(filters?.accountId ? { accountId: filters.accountId } : {}),
      ...(filters?.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters?.type ? { type: filters.type } : {}),
      ...(filters?.startDate || filters?.endDate
        ? {
            transactionDate: {
              ...(filters.startDate ? { gte: filters.startDate } : {}),
              ...(filters.endDate ? { lte: filters.endDate } : {}),
            },
          }
        : {}),
    }

    const rows = await this.prisma.transaction.findMany({
      where: whereClause,
      take: limit + 1,
      ...(cursor
        ? {
            skip: 1,
            cursor: await (async (): Promise<{ id_transactionDate: { id: string; transactionDate: Date } }> => {
              if (cursor.includes('_')) {
                const [id, dateStr] = cursor.split('_')
                if (!id || !dateStr) throw new Error('Invalid cursor format')
                return { id_transactionDate: { id, transactionDate: new Date(dateStr) } }
              }
              const tx = await this.prisma.transaction.findFirst({
                where: { id: cursor },
                select: { transactionDate: true },
              })
              if (!tx) throw new Error('Cursor transaction not found')
              return { id_transactionDate: { id: cursor, transactionDate: tx.transactionDate } }
            })(),
          }
        : {}),
      orderBy: { transactionDate: 'desc' },
      select: SELECT_FIELDS,
    })

    const hasMore = rows.length > limit
    const dataRows = hasMore ? rows.slice(0, limit) : rows

    return {
      data: dataRows.map((row) => toDomain(row)),
      hasMore,
    }
  }

  public async correctCategory(
    id: string,
    categoryId: string,
    userId: string,
    fingerprint: string,
    scope: CorrectionScope,
  ): Promise<number> {
    const tx = await this.prisma.transaction.findFirst({
      where: { id },
      select: { transactionDate: true },
    })
    if (!tx) {
      throw new Error(`Transaction with id ${id} not found`)
    }
    const transactionDate = tx.transactionDate

    const previousHash = await this.findLastEventHash(id)
    const eventId = randomUUID()
    const eventTimestamp = new Date()
    const eventPayload = { categoryId }
    const eventHash = sha256Hex(
      `${eventId}:CORRECTED:${JSON.stringify(eventPayload)}:${eventTimestamp.toISOString()}:${previousHash}`,
    )

    await this.prisma.$transaction([
      this.prisma.transaction.update({
        where: { id_transactionDate: { id, transactionDate } },
        data: { categoryId },
      }),
      this.prisma.transactionEvent.create({
        data: {
          id: eventId,
          transactionId: id,
          transactionDate,
          type: 'CORRECTED',
          payload: eventPayload,
          previousHash,
          hash: eventHash,
          createdAt: eventTimestamp,
        },
      }),
      // Remembering the correction is CONDITIONAL. It used to be
      // unconditional, which quietly turned "this payment was for food" into
      // "everything I ever send this person is food" — right for a shop, wrong
      // for a human being, whose transfers change purpose week to week.
      ...(scope === 'merchant'
        ? [
            this.prisma.userMerchantPreference.upsert({
              where: {
                userId_merchantFingerprint: {
                  userId,
                  merchantFingerprint: fingerprint,
                },
              },
              create: {
                userId,
                merchantFingerprint: fingerprint,
                categoryId,
                correctionCount: 1,
                lastCorrectedAt: new Date(),
              },
              update: {
                categoryId,
                correctionCount: { increment: 1 },
                lastCorrectedAt: new Date(),
              },
            }),
          ]
        : []),
    ])

    if (scope !== 'merchant') return 0

    // ── Backfill ───────────────────────────────────────────────────────────
    // A correction that fixes only the row in front of you leaves every earlier
    // one wrong, so the user walks back through months of history repeating
    // themselves.
    //
    // Matched on the fingerprint rather than the stored name, because the
    // fingerprint is what every other tier keys on — matching the name would
    // miss the spelling variants a fingerprint exists to collapse. The
    // transactions table has no fingerprint column, so the expression below
    // reproduces NormalizerService.getMerchantFingerprint exactly:
    // lowercase, then strip everything that is not a letter or digit. If that
    // derivation ever changes, this must change with it.
    //
    // Scoped to this user's own accounts through the join, and confined to the
    // categories this correction is actually about — see the WHERE clause note.
    const backfilled = await this.prisma.$executeRaw`
      UPDATE transactions t
      SET category_id = ${categoryId}::uuid
      FROM accounts a
      WHERE t.account_id = a.id
        AND a.user_id = ${userId}::uuid
        AND t.id <> ${id}::uuid
        AND t.category_id <> ${categoryId}::uuid
        AND lower(regexp_replace(t.merchant_name, '[^a-zA-Z0-9]', '', 'g')) = ${fingerprint}
    `

    return backfilled
  }

  private async findLastEventHash(transactionId: string): Promise<string> {
    const lastEvent = await this.prisma.transactionEvent.findFirst({
      where: { transactionId },
      orderBy: { createdAt: 'desc' },
      select: { hash: true },
    })
    return lastEvent?.hash ?? '0'
  }
}
