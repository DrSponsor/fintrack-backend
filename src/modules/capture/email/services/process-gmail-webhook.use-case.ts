import type { Queue } from 'bullmq'
import type { PrismaClient } from '../../../../generated/prisma/client'

export type ProcessGmailWebhookUseCaseDeps = {
  readonly prisma: PrismaClient
  readonly captureEmailQueue: Queue
}

export class ProcessGmailWebhookUseCase {
  private readonly prisma: PrismaClient
  private readonly queue: Queue

  public constructor(deps: ProcessGmailWebhookUseCaseDeps) {
    this.prisma = deps.prisma
    this.queue = deps.captureEmailQueue
  }

  public async execute(emailAddress: string, historyId: string): Promise<number> {
    const users = await this.prisma.user.findMany({
      where: { email: emailAddress },
      include: {
        accounts: {
          where: { gmailConnected: true },
        },
      },
    })

    let queueCount = 0
    for (const user of users) {
      for (const account of user.accounts) {
        await this.queue.add(
          'sync-history',
          { accountId: account.id, historyId },
          {
            jobId: `sync-history:${account.id}:${historyId}`, // Deduplicate
          },
        )
        queueCount++
      }
    }
    return queueCount
  }
}
