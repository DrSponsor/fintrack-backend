import type { PrismaClient } from '../../../generated/prisma/client'
import type {
  ITransferRepository,
  TransferCandidate,
  TransferSubject,
} from '../services/transfer-matcher.service'

/**
 * The counterpart query, and the two things it must never do.
 *
 * IT MUST NOT CROSS USERS. Every condition here is scoped through
 * `accounts.user_id`, because the only thing being matched is money moving
 * between accounts one person owns. A join that forgot this would link two
 * strangers' transactions and hide both from their owners' totals.
 *
 * IT MUST NOT MATCH WITHIN AN ACCOUNT. A debit and a credit on the SAME
 * account for the same amount is not a transfer, it is two transactions —
 * commonly a payment and its refund, which the user does want counted.
 */
export class PrismaTransferRepository implements ITransferRepository {
  private readonly prisma: PrismaClient

  public constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  public async findCounterparts(
    subject: TransferSubject,
    windowMs: number,
  ): Promise<readonly TransferCandidate[]> {
    const opposite = subject.type === 'DEBIT' ? 'CREDIT' : 'DEBIT'
    const from = new Date(subject.transactionDate.getTime() - windowMs)
    const to = new Date(subject.transactionDate.getTime() + windowMs)

    // Raw SQL for the account join: the match is defined by the OWNER of the
    // account, which Prisma's nested filters express only as a subquery.
    const rows = await this.prisma.$queryRaw<
      { id: string; account_id: string; transaction_date: Date; transfer_group_id: string | null }[]
    >`
      SELECT t.id, t.account_id, t.transaction_date, t.transfer_group_id
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE a.user_id = ${subject.userId}::uuid
        AND t.account_id <> ${subject.accountId}::uuid
        AND t.id <> ${subject.id}::uuid
        AND t.type = ${opposite}::"TransactionType"
        AND t.amount_kobo = ${subject.amountKobo}
        AND t.transaction_date BETWEEN ${from} AND ${to}
      LIMIT 10
    `

    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      transactionDate: row.transaction_date,
      transferGroupId: row.transfer_group_id,
    }))
  }

  /**
   * Both rows in one statement, so a crash between them cannot leave a group
   * of one — which would hide a single transaction from every total with
   * nothing to pair it against.
   *
   * `transactionDate` is carried because it is half the primary key, so an
   * update addressed by id alone cannot use the index and would scan.
   */
  public async linkAsTransfer(
    a: { readonly id: string; readonly transactionDate: Date },
    b: { readonly id: string; readonly transactionDate: Date },
    groupId: string,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE transactions
      SET transfer_group_id = ${groupId}::uuid
      WHERE (id = ${a.id}::uuid AND transaction_date = ${a.transactionDate})
         OR (id = ${b.id}::uuid AND transaction_date = ${b.transactionDate})
    `
  }
}
