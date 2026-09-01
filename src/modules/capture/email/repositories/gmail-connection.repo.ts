import type { PrismaClient } from '../../../../generated/prisma/client'

/**
 * The user's connected inbox.
 *
 * One row per person, enforced by a unique index on user_id. That constraint
 * is the point of the table: the connection previously lived on Account, so a
 * user with three accounts alerting to one Gmail held the same refresh token
 * three times and revoking it was three writes that could half-fail.
 */
export type GmailConnectionRecord = {
  readonly id: string
  readonly userId: string
  /** The address Google actually authorised, which need not be the signup one. */
  readonly emailAddress: string
  readonly tokenEnc: string
  readonly historyId: string | null
  readonly watchExpiresAt: Date | null
  readonly connectedAt: Date
}

export interface IGmailConnectionRepository {
  findByUserId(userId: string): Promise<GmailConnectionRecord | null>
  /** Resolves an incoming Gmail push notification to the person it concerns. */
  findByEmailAddress(emailAddress: string): Promise<readonly GmailConnectionRecord[]>
  /** Connect, or re-connect with a fresh token. One row per user either way. */
  upsert(input: {
    readonly userId: string
    readonly emailAddress: string
    readonly tokenEnc: string
  }): Promise<GmailConnectionRecord>
  /**
   * Replaces the stored token WITHOUT disturbing the sync cursor.
   *
   * Distinct from `upsert` on purpose. Google rotates a refresh token during
   * an ordinary refresh, which happens routinely on a live connection — going
   * through `upsert` would clear historyId every time and turn each rotation
   * into a full re-scan of the mailbox.
   */
  saveToken(userId: string, tokenEnc: string): Promise<void>
  /** Records where a sync reached, so the next one resumes. */
  saveHistoryId(userId: string, historyId: string): Promise<void>
  /** Gmail watches lapse after seven days; the renewal worker keeps this. */
  saveWatch(userId: string, historyId: string, expiresAt: Date): Promise<void>
  /** Every connection whose watch has lapsed or is about to. */
  findExpiringWatches(before: Date): Promise<readonly GmailConnectionRecord[]>
  /** Disconnecting is now ONE delete, whatever the account count. */
  remove(userId: string): Promise<void>
}

export class PrismaGmailConnectionRepository implements IGmailConnectionRepository {
  private readonly prisma: PrismaClient

  public constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  public async findByUserId(userId: string): Promise<GmailConnectionRecord | null> {
    return this.prisma.gmailConnection.findUnique({ where: { userId } })
  }

  /**
   * Returns a LIST, though the address is not unique by design.
   *
   * Two people can legitimately connect the same shared mailbox, and a push
   * notification names only the address. Returning one row would silently pick
   * a winner and stop capture for everyone else on that mailbox.
   */
  public async findByEmailAddress(emailAddress: string): Promise<readonly GmailConnectionRecord[]> {
    return this.prisma.gmailConnection.findMany({ where: { emailAddress } })
  }

  public async upsert(input: {
    readonly userId: string
    readonly emailAddress: string
    readonly tokenEnc: string
  }): Promise<GmailConnectionRecord> {
    return this.prisma.gmailConnection.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        emailAddress: input.emailAddress,
        tokenEnc: input.tokenEnc,
      },
      // Re-connecting clears the sync cursor and the watch: they belong to the
      // previous grant, and a stale historyId against a new token asks Gmail
      // to resume from a point it will reject.
      update: {
        emailAddress: input.emailAddress,
        tokenEnc: input.tokenEnc,
        historyId: null,
        watchExpiresAt: null,
        connectedAt: new Date(),
      },
    })
  }

  public async saveToken(userId: string, tokenEnc: string): Promise<void> {
    await this.prisma.gmailConnection.update({ where: { userId }, data: { tokenEnc } })
  }

  public async saveHistoryId(userId: string, historyId: string): Promise<void> {
    await this.prisma.gmailConnection.update({ where: { userId }, data: { historyId } })
  }

  public async saveWatch(userId: string, historyId: string, expiresAt: Date): Promise<void> {
    await this.prisma.gmailConnection.update({
      where: { userId },
      data: { historyId, watchExpiresAt: expiresAt },
    })
  }

  public async findExpiringWatches(before: Date): Promise<readonly GmailConnectionRecord[]> {
    return this.prisma.gmailConnection.findMany({
      where: {
        OR: [
          { watchExpiresAt: { lte: before } },
          // Never watched. A connection made while the renewal worker was down
          // would otherwise sit forever with no watch and no way to acquire one.
          { watchExpiresAt: null },
        ],
      },
    })
  }

  public async remove(userId: string): Promise<void> {
    await this.prisma.gmailConnection.deleteMany({ where: { userId } })
  }
}
