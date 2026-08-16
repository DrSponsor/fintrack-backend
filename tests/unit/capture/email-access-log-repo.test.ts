import { describe, expect, it, vi } from 'vitest'
import { PrismaEmailAccessLogRepository } from '../../../src/modules/capture/email/repositories/email-access-log.repo'

function makeRow(id: string, accessedAt: Date) {
  return {
    id,
    userId: 'user-1',
    accountId: 'account-1',
    messageId: `msg-${id}`,
    senderDomain: 'gtbank.com',
    subject: 'Debit Alert',
    outcome: 'TRANSACTION_CREATED' as const,
    accessedAt,
  }
}

function makeMockPrisma(rows: ReturnType<typeof makeRow>[]) {
  return {
    emailAccessLog: {
      create: vi.fn(),
      findMany: vi.fn((args: { take: number; cursor?: { id: string }; skip?: number }) => {
        let source = rows
        if (args.cursor) {
          const cursorIndex = source.findIndex((r) => r.id === args.cursor!.id)
          source = cursorIndex >= 0 ? source.slice(cursorIndex + (args.skip ?? 0)) : []
        }
        return Promise.resolve(source.slice(0, args.take))
      }),
    },
  } as any
}

describe('PrismaEmailAccessLogRepository', () => {
  describe('findByUser', () => {
    it('returns hasMore: false when fewer rows exist than the page limit', async () => {
      const rows = [makeRow('1', new Date()), makeRow('2', new Date())]
      const repo = new PrismaEmailAccessLogRepository(makeMockPrisma(rows))

      const result = await repo.findByUser('user-1', undefined, 20)

      expect(result.data).toHaveLength(2)
      expect(result.hasMore).toBe(false)
    })

    it('returns hasMore: true and trims the extra lookahead row when more pages exist', async () => {
      const rows = [makeRow('1', new Date()), makeRow('2', new Date()), makeRow('3', new Date())]
      const repo = new PrismaEmailAccessLogRepository(makeMockPrisma(rows))

      const result = await repo.findByUser('user-1', undefined, 2)

      expect(result.data).toHaveLength(2)
      expect(result.data.map((r) => r.id)).toEqual(['1', '2'])
      expect(result.hasMore).toBe(true)
    })

    it('defaults to a limit of 20 when none is provided', async () => {
      const rows = Array.from({ length: 25 }, (_, i) => makeRow(String(i), new Date()))
      const repo = new PrismaEmailAccessLogRepository(makeMockPrisma(rows))

      const result = await repo.findByUser('user-1')

      expect(result.data).toHaveLength(20)
      expect(result.hasMore).toBe(true)
    })
  })

  describe('create', () => {
    it('passes all fields through to Prisma and returns the created row', async () => {
      const prisma = makeMockPrisma([])
      const created = makeRow('new-id', new Date())
      prisma.emailAccessLog.create.mockResolvedValue(created)
      const repo = new PrismaEmailAccessLogRepository(prisma)

      const result = await repo.create({
        userId: 'user-1',
        accountId: 'account-1',
        messageId: 'msg-new-id',
        senderDomain: 'gtbank.com',
        subject: 'Debit Alert',
        outcome: 'TRANSACTION_CREATED',
      })

      expect(result).toEqual(created)
      expect(prisma.emailAccessLog.create).toHaveBeenCalledOnce()
    })
  })
})
