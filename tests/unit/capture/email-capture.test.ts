import { describe, expect, it, vi } from 'vitest'
import { SafetyFilterService } from '../../../src/modules/capture/email/services/safety-filter.service'
import { GtbParser } from '../../../src/modules/capture/email/parsers/gtb.parser'
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
import { ReconciliationService } from '../../../src/modules/transactions/services/reconciliation.service'

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

  // ── Regression: the filter used to discard real bank alerts ─────────────
  //
  // The tests above all passed a subject and no body, so `bodyText` defaulted
  // to '' and the body path was never executed. Both bugs below lived entirely
  // in that unexercised path, and both dropped the exact emails the product
  // exists to read — silently, logged as "discarded by safety gate", which
  // reads like the system working correctly.

  /** A real Access Bank alert: the bank's standard security footer, plus the
   *  kind of tracking pixel every HTML mail carries. */
  const REAL_BANK_ALERT_BODY =
    'Debit Alert Amt:NGN1,234.56 Acc:012******345 ' +
    'Desc:312ABCD2600000AA/MOBILE TRF TO PAY Date:05/03/2026 Avail Bal:NGN50,000.00 ' +
    '<img src="https://t.example.com/px/a2fa9c1b7e"> ' +
    'Access Bank will never ask you to disclose your PIN, password or OTP to anyone.'

  it('keeps a real bank alert whose footer mentions OTP', () => {
    // Bank alerts warn you to protect your OTP every single time. Treating the
    // word as a security-email marker anywhere in the body meant the filter was
    // most likely to reject precisely the mail it was built to accept.
    expect(filter.shouldDiscard('Access Bank Transaction Alert', REAL_BANK_ALERT_BODY)).toBe(false)
  })

  it('does not match 2fa/mfa/otp inside hex or tracking tokens', () => {
    // 'a2fa9c1b7e' contains '2fa'. With substring matching, any HTML email
    // whose tracking URL happened to include those characters was classified
    // as a two-factor notice.
    expect(filter.shouldDiscard('Transaction Notification', 'ref a2fa9c1b7e')).toBe(false)
    expect(filter.shouldDiscard('Transaction Notification', 'id 7mfa22x')).toBe(false)
    expect(filter.shouldDiscard('Transaction Notification', 'token xotpy9')).toBe(false)
  })

  it('still discards genuine security mail', () => {
    // The fix must not blunt the filter: storing an OTP would be far worse
    // than dropping a transaction.
    expect(filter.shouldDiscard('Your OTP is 123456', 'Use 123456 to log in')).toBe(true)
    expect(filter.shouldDiscard('Your 2FA code', 'body')).toBe(true)
    expect(filter.shouldDiscard('Security alert', 'Someone signed in')).toBe(true)
    // Unambiguous multi-word phrases are still caught in the body alone.
    expect(filter.shouldDiscard('Account notice', 'Your verification code is 8891')).toBe(true)
    expect(filter.shouldDiscard('Account notice', 'Click here to reset your password')).toBe(true)
  })

  it('finds transaction keywords in a body, not just a subject', () => {
    expect(filter.hasTransactionKeywords('Notification', REAL_BANK_ALERT_BODY)).toBe(true)
    expect(filter.hasTransactionKeywords('Notification', 'nothing of interest here')).toBe(false)
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
    // Access Bank has moved to tests/unit/capture/access-parser.test.ts, which
    // exercises the real HTML Access actually sends.
    //
    // The fixture that lived here asserted
    //   'Amt of NGN 10,500.50 Dr; Desc: POS SPAR; Date: 14-Jun-2026; ...'
    // — semicolon-delimited Label: value pairs. Access sends an HTML table with
    // no colons and no Amt label at all. The test passed for as long as it
    // existed while the parser failed on every one of the 41 real alerts in a
    // live mailbox, because fixture and parser were written from the same
    // assumption and only ever checked against each other.
    //
    // The remaining rows below are the same shape and were written the same
    // way, so they carry the same risk: passing here is not evidence that any
    // of them parses real mail. Each needs replacing with a captured alert as
    // samples become available.
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
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
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
      } as any)
    })

    const latestHistoryId = await discovery.syncHistory('account-1', '54321', 'fake-access-token', null)
    expect(latestHistoryId).toBe('98765')
    expect(mockQueue.add).toHaveBeenCalledTimes(2)
    expect(mockQueue.add).toHaveBeenNthCalledWith(1, 'ingest-message', { accountId: 'account-1', messageId: 'msg-1' }, { jobId: 'email-ingest-account-1-msg-1' })
    expect(mockQueue.add).toHaveBeenNthCalledWith(2, 'ingest-message', { accountId: 'account-1', messageId: 'msg-2' }, { jobId: 'email-ingest-account-1-msg-2' })

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

    const mockEmailAccessLogRepo = { create: vi.fn() } as any

    const worker = new EmailIngestWorker({
      connection: {},
      concurrency: 1,
      prisma: {} as any,
      accountRepo: mockAccountRepo,
      transactionRepo: {} as any,
      emailAccessLogRepo: mockEmailAccessLogRepo,
      oauthService: mockOauthService,
      fetchService: mockFetchService,
      safetyFilter: {} as any,
      parserRegistry: {} as any,
      aiUniversalParser: {} as any,
      discoveryService: {} as any,
      normalizer: {} as any,
      categorizer: {} as any,
      reconciliation: new ReconciliationService(),
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
      { delay: 2 * 60 * 60 * 1000, jobId: 'quota-msg-1' },
    )
    // No email was successfully accessed yet (fetch failed) — nothing to log.
    expect(mockEmailAccessLogRepo.create).not.toHaveBeenCalled()
  })

  // ────────────────────────────────────────────────────────────────
  // Email access log — NDPR transparency requirement
  // ────────────────────────────────────────────────────────────────
  describe('email access logging', () => {
    const baseEmail = {
      id: 'gmail-msg-1',
      subject: 'Debit Alert',
      from: 'alerts@gtbank.com',
      senderEmail: 'alerts@gtbank.com',
      senderDomain: 'gtbank.com',
      date: new Date(),
      bodyHtml: '<p>body</p>',
      bodyText: 'body',
    }

    function makeDeps(overrides: Record<string, any> = {}) {
      const mockEmailAccessLogRepo = { create: vi.fn() }
      const deps = {
        connection: {} as any,
        concurrency: 1,
        prisma: { user: { findUnique: vi.fn().mockResolvedValue({ tier: 'FREE' }) } } as any,
        accountRepo: {
          findById: vi.fn().mockResolvedValue({
            id: 'account-1',
            userId: 'user-1',
            gmailConnected: true,
            accountLast4: '1234',
          }),
        } as any,
        transactionRepo: {
          create: vi.fn().mockResolvedValue({ id: 'tx-1' }),
          findByIdempotencyKey: vi.fn().mockResolvedValue(null),
          findMatchCandidates: vi.fn().mockResolvedValue([]),
          supersede: vi.fn().mockResolvedValue({ id: 'tx-1' }),
        } as any,
        emailAccessLogRepo: mockEmailAccessLogRepo as any,
        oauthService: { getValidAccessToken: vi.fn().mockResolvedValue('fake-access-token') } as any,
        fetchService: { fetchEmailWithBackoff: vi.fn().mockResolvedValue(baseEmail) } as any,
        safetyFilter: {
          shouldDiscard: vi.fn().mockReturnValue(false),
          hasTransactionKeywords: vi.fn().mockReturnValue(true),
        } as any,
        parserRegistry: { getParserForDomain: vi.fn().mockReturnValue(null) } as any,
        aiUniversalParser: {
          parse: vi.fn().mockResolvedValue({
            tx: {
              merchantName: 'POS Purchase',
              amountKobo: 100000n,
              type: 'DEBIT',
              transactionDate: new Date(),
              balanceAfterKobo: 500000n,
            },
            isVerified: false,
          }),
        } as any,
        discoveryService: {} as any,
        normalizer: {
          normalizeMerchantName: vi.fn((n: string) => n),
          getMerchantFingerprint: vi.fn().mockReturnValue('fingerprint-1'),
        } as any,
        categorizer: { categorize: vi.fn().mockResolvedValue('category-1') } as any,
        reconciliation: new ReconciliationService(),
        logger: mockLogger,
        captureEmailQueue: { add: vi.fn() } as any,
        ...overrides,
      }
      return { deps, mockEmailAccessLogRepo }
    }

    const mockJob = {
      name: 'ingest-message',
      data: { accountId: 'account-1', messageId: 'gmail-msg-1' },
    } as any

    it('logs TRANSACTION_CREATED on successful ingestion', async () => {
      const { deps, mockEmailAccessLogRepo } = makeDeps()
      const worker = new EmailIngestWorker(deps)

      await (worker as any).processJob(mockJob)

      expect(mockEmailAccessLogRepo.create).toHaveBeenCalledWith({
        userId: 'user-1',
        accountId: 'account-1',
        messageId: 'gmail-msg-1',
        senderDomain: 'gtbank.com',
        subject: 'Debit Alert',
        outcome: 'TRANSACTION_CREATED',
      })
    })

    it('logs DISCARDED_SAFETY_FILTER when the safety gate discards the email', async () => {
      const { deps, mockEmailAccessLogRepo } = makeDeps({
        safetyFilter: {
          shouldDiscard: vi.fn().mockReturnValue(true),
          hasTransactionKeywords: vi.fn().mockReturnValue(true),
        },
      })
      const worker = new EmailIngestWorker(deps)

      await (worker as any).processJob(mockJob)

      expect(mockEmailAccessLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'DISCARDED_SAFETY_FILTER' }),
      )
    })

    it('logs DISCARDED_NO_KEYWORDS when no transaction keywords are found', async () => {
      const { deps, mockEmailAccessLogRepo } = makeDeps({
        safetyFilter: {
          shouldDiscard: vi.fn().mockReturnValue(false),
          hasTransactionKeywords: vi.fn().mockReturnValue(false),
        },
      })
      const worker = new EmailIngestWorker(deps)

      await (worker as any).processJob(mockJob)

      expect(mockEmailAccessLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'DISCARDED_NO_KEYWORDS' }),
      )
    })

    it('logs PARSE_FAILED when no parser can extract a transaction', async () => {
      const { deps, mockEmailAccessLogRepo } = makeDeps({
        aiUniversalParser: { parse: vi.fn().mockResolvedValue({ tx: null, isVerified: false }) },
      })
      const worker = new EmailIngestWorker(deps)

      await (worker as any).processJob(mockJob)

      expect(mockEmailAccessLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'PARSE_FAILED' }),
      )
    })

    it('logs DUPLICATE_SUPPRESSED when this message has already produced a row', async () => {
      // Checked explicitly rather than left to the unique constraint, which
      // spans (idempotency_key, transaction_date) and so cannot see a redelivery
      // whose row was superseded onto a different date.
      const { deps, mockEmailAccessLogRepo } = makeDeps({
        transactionRepo: {
          create: vi.fn(),
          findByIdempotencyKey: vi.fn().mockResolvedValue({ id: 'existing-tx-id' }),
          findMatchCandidates: vi.fn().mockResolvedValue([]),
          supersede: vi.fn(),
        },
      })
      const worker = new EmailIngestWorker(deps)

      await (worker as any).processJob(mockJob)

      expect(mockEmailAccessLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'DUPLICATE_SUPPRESSED' }),
      )
      expect(deps.transactionRepo.create).not.toHaveBeenCalled()
    })

    it('logs DUPLICATE_SUPPRESSED when the money is already in the ledger', async () => {
      const { deps, mockEmailAccessLogRepo } = makeDeps({
        transactionRepo: {
          create: vi.fn(),
          findByIdempotencyKey: vi.fn().mockResolvedValue(null),
          findMatchCandidates: vi.fn().mockResolvedValue([
            {
              id: 'existing-tx-id',
              merchantName: 'POS Purchase',
              transactionDate: new Date(),
              source: 'EMAIL',
              categoryId: 'category-1',
            },
          ]),
          supersede: vi.fn(),
        },
      })
      const worker = new EmailIngestWorker(deps)

      await (worker as any).processJob(mockJob)

      expect(mockEmailAccessLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'DUPLICATE_SUPPRESSED' }),
      )
      expect(deps.transactionRepo.create).not.toHaveBeenCalled()
    })

    it('supersedes a manual placeholder instead of creating a second row', async () => {
      // The whole point of the manual-entry conflict work: the user typed the
      // payment in themselves, and the bank's version now replaces it in place
      // rather than sitting beside it.
      const { deps } = makeDeps({
        transactionRepo: {
          create: vi.fn(),
          findByIdempotencyKey: vi.fn().mockResolvedValue(null),
          findMatchCandidates: vi.fn().mockResolvedValue([
            {
              id: 'placeholder-id',
              merchantName: 'Fuel',
              transactionDate: new Date(),
              source: 'MANUAL',
              categoryId: 'user-chosen-category',
            },
          ]),
          supersede: vi.fn().mockResolvedValue({ id: 'placeholder-id' }),
        },
      })
      const worker = new EmailIngestWorker(deps)

      await (worker as any).processJob(mockJob)

      expect(deps.transactionRepo.create).not.toHaveBeenCalled()
      expect(deps.transactionRepo.supersede).toHaveBeenCalledWith(
        'placeholder-id',
        expect.objectContaining({
          source: 'EMAIL',
          idempotencyKey: 'gmail-msg-1',
          // The category is the one field the user may have set deliberately,
          // and a deliberate choice is indistinguishable from the categoriser's
          // guess after the fact — so it is carried over, not re-derived.
          categoryId: 'user-chosen-category',
        }),
      )
    })

    it('logs DUPLICATE_SUPPRESSED when a concurrent write hits the DB unique constraint', async () => {
      const { deps, mockEmailAccessLogRepo } = makeDeps({
        transactionRepo: {
          create: vi.fn().mockRejectedValue({ code: 'P2002' }),
          findByIdempotencyKey: vi.fn().mockResolvedValue(null),
          findMatchCandidates: vi.fn().mockResolvedValue([]),
          supersede: vi.fn(),
        },
      })
      const worker = new EmailIngestWorker(deps)

      await (worker as any).processJob(mockJob)

      expect(mockEmailAccessLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'DUPLICATE_SUPPRESSED' }),
      )
    })

    it('does not let a logging failure break transaction ingestion', async () => {
      const { deps, mockEmailAccessLogRepo } = makeDeps()
      mockEmailAccessLogRepo.create.mockRejectedValue(new Error('DB write failed'))
      const worker = new EmailIngestWorker(deps)

      // Should not throw, despite the logging call failing internally.
      await expect((worker as any).processJob(mockJob)).resolves.toBeUndefined()
      expect(deps.transactionRepo.create).toHaveBeenCalledOnce()
    })
  })
})
