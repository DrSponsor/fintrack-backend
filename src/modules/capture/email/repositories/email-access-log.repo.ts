import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../../../generated/prisma/client'
import type { EmailAccessOutcome } from '../../../../generated/prisma/enums'

// ──────────────────────────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────────────────────────

export type EmailAccessLogRecord = {
  readonly id: string
  readonly userId: string
  /** Null when the email could not be attributed to one. */
  readonly accountId: string | null
  readonly messageId: string
  readonly senderDomain: string
  readonly subject: string
  readonly outcome: EmailAccessOutcome
  readonly accessedAt: Date
}

export type CreateEmailAccessLogInput = {
  readonly userId: string
  /** Null when the email could not be attributed to one. */
  readonly accountId: string | null
  readonly messageId: string
  readonly senderDomain: string
  readonly subject: string
  readonly outcome: EmailAccessOutcome
}

// ──────────────────────────────────────────────────────────────────
// Repository interface
// ──────────────────────────────────────────────────────────────────

export interface IEmailAccessLogRepository {
  create(data: CreateEmailAccessLogInput): Promise<EmailAccessLogRecord>
  findByUser(
    userId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ readonly data: readonly EmailAccessLogRecord[]; readonly hasMore: boolean }>
}

// ──────────────────────────────────────────────────────────────────
// Prisma implementation
// ──────────────────────────────────────────────────────────────────

export class PrismaEmailAccessLogRepository implements IEmailAccessLogRepository {
  public constructor(private readonly prisma: PrismaClient) {}

  public async create(data: CreateEmailAccessLogInput): Promise<EmailAccessLogRecord> {
    const row = await this.prisma.emailAccessLog.create({
      data: {
        id: randomUUID(),
        userId: data.userId,
        accountId: data.accountId,
        messageId: data.messageId,
        senderDomain: data.senderDomain,
        subject: data.subject,
        outcome: data.outcome,
      },
    })
    return row
  }

  public async findByUser(
    userId: string,
    cursor?: string,
    limit = 20,
  ): Promise<{ readonly data: readonly EmailAccessLogRecord[]; readonly hasMore: boolean }> {
    const rows = await this.prisma.emailAccessLog.findMany({
      where: { userId },
      orderBy: [{ accessedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1, // Skip the cursor row itself — it was already returned in the previous page
          }
        : {}),
    })

    const hasMore = rows.length > limit
    const data = hasMore ? rows.slice(0, limit) : rows

    return { data, hasMore }
  }
}
