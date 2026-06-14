import { describe, expect, it, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { SafetyFilterService } from '../../../src/modules/capture/email/services/safety-filter.service'
import { GtbParser } from '../../../src/modules/capture/email/parsers/gtb.parser'
import { AccessParser } from '../../../src/modules/capture/email/parsers/access.parser'
import { ZenithParser } from '../../../src/modules/capture/email/parsers/zenith.parser'
import { UbaParser } from '../../../src/modules/capture/email/parsers/uba.parser'
import { FirstBankParser } from '../../../src/modules/capture/email/parsers/firstbank.parser'
import { KudaParser } from '../../../src/modules/capture/email/parsers/kuda.parser'
import { OpayParser } from '../../../src/modules/capture/email/parsers/opay.parser'
import { MoniepointParser } from '../../../src/modules/capture/email/parsers/moniepoint.parser'
import { WemaParser } from '../../../src/modules/capture/email/parsers/wema.parser'
import { FidelityParser } from '../../../src/modules/capture/email/parsers/fidelity.parser'
import { DiscoveryService } from '../../../src/modules/capture/email/services/discovery.service'
import { EmailIngestWorker } from '../../../src/modules/capture/email/workers/email-ingest.worker'
import { GmailQuotaExhaustedError } from '../../../src/modules/capture/email/services/fetch.service'

vi.mock('bullmq', () => {
  return {
    Queue: vi.fn().mockImplementation(() => {
      return {
        add: vi.fn(),
        close: vi.fn(),
      }
    }),
    Worker: vi.fn().mockImplementation(() => {
      return {
        on: vi.fn(),
        close: vi.fn(),
      }
    }),
    QueueEvents: vi.fn().mockImplementation(() => {
      return {
        on: vi.fn(),
        close: vi.fn(),
      }
    }),
  }
})

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => mockLogger,
} as any

describe('SafetyFilterService', () => {
  const filter = new SafetyFilterService()

  it('should discard security-related emails', () => {
    expect(filter.shouldDiscard('Your OTP is 123456')).toBe(true)
    expect(filter.shouldDiscard('Reset your password')).toBe(true)
    expect(filter.shouldDiscard('New login alert from Chrome')).toBe(true)
    expect(filter.shouldDiscard('Normal Transaction Notification')).toBe(false)
  })

  it('should identify transaction keywords', () => {
    expect(filter.hasTransactionKeywords('Debit Alert for Account')).toBe(true)
    expect(filter.hasTransactionKeywords('Payment successful')).toBe(true)
    expect(filter.hasTransactionKeywords('Hello world')).toBe(false)
  })
})

describe('Bank Parsers (Table-Driven)', () => {
  const testCases = [
    {
      parser: new GtbParser(),
      bank: 'GTBank',
      subject: 'GTBank Transaction Alert',
      body: 'Amt: NGN 5,000.00 Cr; Desc: Transfer from Mom; Date: 14-Jun-2026; Bal: NGN 15,000.00',
      expectedAmount: 500000n,
      expectedType: 'CREDIT',
      expectedMerchant: 'Transfer from Mom',
      expectedBalance: 1500000n,
    },
    {
      parser: new AccessParser(),
      bank: 'Access Bank',
      subject: 'Access Bank Alert',
      body: 'Amt of NGN 10,500.50 Dr; Desc: POS SPAR; Date: 14-Jun-2026; Bal: NGN 4,500.00',
      expectedAmount: 1050050n,
      expectedType: 'DEBIT',
      expectedMerchant: 'POS SPAR',
      expectedBalance: 450000n,
    },
    {
      parser: new ZenithParser(),
      bank: 'Zenith Bank',
      subject: 'Zenith Transaction Notification',
      body: 'Amount: NGN 2,500.00 Cr; Description: Interest Payment; Date: 14-Jun-2026; Balance: NGN 50,000.00',
      expectedAmount: 250000n,
      expectedType: 'CREDIT',
      expectedMerchant: 'Interest Payment',
      expectedBalance: 5000000n,
    },
    {
      parser: new UbaParser(),
      bank: 'UBA',
      subject: 'UBA Transaction Alert',
      body: 'Amount: NGN 1,200.00 Dr; Remarks: Transfer to John; Date: 14-Jun-2026; Balance: NGN 8,800.00',
      expectedAmount: 120000n,
      expectedType: 'DEBIT',
      expectedMerchant: 'Transfer to John',
      expectedBalance: 880000n,
    },
    {
      parser: new FirstBankParser(),
      bank: 'FirstBank',
      subject: 'FirstBank Transaction Alert',
      body: 'Amount: NGN 100,000.00 Cr; Narration: Salary; Date: 14-Jun-2026; Balance: NGN 120,000.00',
      expectedAmount: 10000000n,
      expectedType: 'CREDIT',
      expectedMerchant: 'Salary',
      expectedBalance: 12000000n,
    },
    {
      parser: new KudaParser(),
      bank: 'Kuda',
      subject: 'Kuda Transaction Alert',
      body: 'Amount: NGN 3,500.00 Dr; Narration: Netflix; Date: 14-Jun-2026; Balance: NGN 6,500.00',
      expectedAmount: 350000n,
      expectedType: 'DEBIT',
      expectedMerchant: 'Netflix',
      expectedBalance: 650000n,
    },
    {
      parser: new OpayParser(),
      bank: 'OPay',
      subject: 'OPay Alert',
      body: 'Amount: NGN 450.00 Dr; Narration: Ride; Date: 14-Jun-2026; Balance: NGN 2,550.00',
      expectedAmount: 45000n,
      expectedType: 'DEBIT',
      expectedMerchant: 'Ride',
      expectedBalance: 255000n,
    },
    {
      parser: new MoniepointParser(),
      bank: 'Moniepoint',
      subject: 'Moniepoint Transaction Alert',
      body: 'Amount: NGN 15,000.00 Cr; Narration: Transfer; Date: 14-Jun-2026; Balance: NGN 20,000.00',
      expectedAmount: 1500000n,
      expectedType: 'CREDIT',
      expectedMerchant: 'Transfer',
      expectedBalance: 2000000n,
    },
    {
      parser: new WemaParser(),
      bank: 'Wema Bank',
      subject: 'Wema Alert',
      body: 'Amount: NGN 8,000.00 Dr; Narration: POS; Date: 14-Jun-2026; Balance: NGN 12,000.00',
      expectedAmount: 800000n,
      expectedType: 'DEBIT',
      expectedMerchant: 'POS',
      expectedBalance: 1200000n,
    },
    {
      parser: new FidelityParser(),
      bank: 'Fidelity Bank',
      subject: 'Fidelity Alert',
      body: 'Amount: NGN 60,000.00 Cr; Narration: Dividends; Date: 14-Jun-2026; Balance: NGN 100,000.00',
      expectedAmount: 6000000n,
      expectedType: 'CREDIT',
      expectedMerchant: 'Dividends',
      expectedBalance: 10000000n,
    },
  ]

  for (const tc of testCases) {
    it(`should parse typical ${tc.bank} alerts correctly`, async () => {
      const parsed = await tc.parser.parse(tc.subject, tc.body, '')
      expect(parsed).not.toBeNull()
      expect(parsed!.amountKobo).toBe(tc.expectedAmount)
      expect(parsed!.type).toBe(tc.expectedType)
      expect(parsed!.merchantName).toBe(tc.expectedMerchant)
      expect(parsed!.balanceAfterKobo).toBe(tc.expectedBalance)
    })
  }
})

describe('DiscoveryService', () => {
  it('should list and queue messages from history endpoint', async () => {
    const mockQueue = {
      add: vi.fn(),
    } as any

    const discovery = new DiscoveryService({
      captureEmailQueue: mockQueue,
      logger: mockLogger,
    })

    // Mock global fetch to return a list of history records
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        json: async () => ({
          historyId: '98765',
          history: [
            {
              id: '123',
              messagesAdded: [
                { message: { id: 'msg-1' } },
                { message: { id: 'msg-2' } },
              ],
            },
          ],
        }),
      } as any
    })

    const latestHistoryId = await discovery.syncHistory('account-1', '54321', 'fake-access-token', null)
    expect(latestHistoryId).toBe('98765')
    expect(mockQueue.add).toHaveBeenCalledTimes(2)
    expect(mockQueue.add).toHaveBeenNthCalledWith(1, 'ingest-message', { accountId: 'account-1', messageId: 'msg-1' }, { jobId: 'email-ingest:account-1:msg-1' })
    expect(mockQueue.add).toHaveBeenNthCalledWith(2, 'ingest-message', { accountId: 'account-1', messageId: 'msg-2' }, { jobId: 'email-ingest:account-1:msg-2' })

    fetchSpy.mockRestore()
  })
})

describe('EmailIngestWorker', () => {
  it('should defer the job for 2 hours when GmailQuotaExhaustedError is thrown', async () => {
    const mockQueue = {
      add: vi.fn(),
    } as any

    const mockAccountRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'account-1',
        userId: 'user-1',
        gmailConnected: true,
        accountLast4: '1234',
      }),
    } as any

    const mockOauthService = {
      getValidAccessToken: vi.fn().mockResolvedValue('fake-access-token'),
    } as any

    const mockFetchService = {
      fetchEmailWithBackoff: vi.fn().mockRejectedValue(new GmailQuotaExhaustedError()),
    } as any

    const worker = new EmailIngestWorker({
      connection: {} as any,
      concurrency: 1,
      prisma: {} as any,
      accountRepo: mockAccountRepo,
      transactionRepo: {} as any,
      oauthService: mockOauthService,
      fetchService: mockFetchService,
      safetyFilter: {} as any,
      parserRegistry: {} as any,
      aiUniversalParser: {} as any,
      discoveryService: {} as any,
      normalizer: {} as any,
      categorizer: {} as any,
      deduplicator: {} as any,
      logger: mockLogger,
      captureEmailQueue: mockQueue,
    })

    const mockJob = {
      name: 'ingest-message',
      data: { accountId: 'account-1', messageId: 'msg-1' },
      queue: mockQueue,
    } as any

    // We call the private processJob to simulate BullMQ processing
    await (worker as any).processJob(mockJob)

    expect(mockQueue.add).toHaveBeenCalledTimes(1)
    expect(mockQueue.add).toHaveBeenCalledWith(
      'ingest-message',
      { accountId: 'account-1', messageId: 'msg-1' },
      { delay: 2 * 60 * 60 * 1000, jobId: 'quota:msg-1' },
    )
  })
})
