import { describe, expect, it, vi } from 'vitest'
import { SafetyFilterService } from '../../../src/modules/capture/email/services/safety-filter.service'
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

/*
 * The table-driven bank parser suite lived here and has been removed with the
 * nine parsers it covered.
 *
 * Every fixture in it asserted one invented shape —
 *   'Amt: NGN 5,000.00 Cr; Desc: ...; Date: ...; Bal: ...'
 * — and each parser was written to that same shape, so the suite only ever
 * checked the parsers against the assumption that produced them. It was green
 * for as long as it existed.
 *
 * The one member of that family that ever met real mail was Access, which
 * failed all 41 alerts in a live mailbox while this suite passed. Its
 * replacement is tests/unit/capture/access-parser.test.ts, written against the
 * HTML Access actually sends.
 *
 * A parser earns a test here by being run against a captured alert first, not
 * by being written alongside a fixture that agrees with it.
 */

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
    expect(mockQueue.add).toHaveBeenNthCalledWith(1, 'ingest-message', { userId: 'account-1', messageId: 'msg-1' }, { jobId: 'email-ingest-account-1-msg-1' })
    expect(mockQueue.add).toHaveBeenNthCalledWith(2, 'ingest-message', { userId: 'account-1', messageId: 'msg-2' }, { jobId: 'email-ingest-account-1-msg-2' })

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
      connectionRepo: {
        findByUserId: vi.fn().mockResolvedValue({
          id: 'conn-1',
          userId: 'user-1',
          emailAddress: 'someone@example.test',
          tokenEnc: 'enc',
          historyId: null,
          watchExpiresAt: null,
          connectedAt: new Date(),
        }),
      } as any,
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
      transferMatcher: { evaluate: vi.fn().mockResolvedValue({ linked: false }) } as never,
      logger: mockLogger,
      captureEmailQueue: mockQueue,
    })

    const mockJob = {
      name: 'ingest-message',
      data: { userId: 'user-1', messageId: 'msg-1' },
      queue: mockQueue,
    } as any

    // We call the private processJob to simulate BullMQ processing
    await (worker as any).processJob(mockJob)

    expect(mockQueue.add).toHaveBeenCalledTimes(1)
    expect(mockQueue.add).toHaveBeenCalledWith(
      'ingest-message',
      { userId: 'user-1', messageId: 'msg-1' },
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
          findByUserId: vi.fn().mockResolvedValue([
            { id: 'account-1', accountLast4: '1234' },
          ]),
        } as any,
        transactionRepo: {
          create: vi.fn().mockResolvedValue({ id: 'tx-1' }),
          findByIdempotencyKey: vi.fn().mockResolvedValue(null),
          findMatchCandidates: vi.fn().mockResolvedValue([]),
          supersede: vi.fn().mockResolvedValue({ id: 'tx-1' }),
        } as any,
        connectionRepo: {
        findByUserId: vi.fn().mockResolvedValue({
          id: 'conn-1',
          userId: 'user-1',
          emailAddress: 'someone@example.test',
          tokenEnc: 'enc',
          historyId: null,
          watchExpiresAt: null,
          connectedAt: new Date(),
        }),
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
      transferMatcher: { evaluate: vi.fn().mockResolvedValue({ linked: false }) } as never,
        logger: mockLogger,
        captureEmailQueue: { add: vi.fn() } as any,
        ...overrides,
      }
      return { deps, mockEmailAccessLogRepo }
    }

    const mockJob = {
      name: 'ingest-message',
      data: { userId: 'user-1', messageId: 'gmail-msg-1' },
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


    describe('which account the alert is about', () => {
      /** An alert whose masked number ends in the digits of the second account. */
      const namingSecondAccount = {
        parse: vi.fn().mockResolvedValue({
          tx: {
            merchantName: 'POS Purchase',
            amountKobo: 100000n,
            type: 'DEBIT',
            transactionDate: new Date(),
            accountMask: '012******802',
          },
          isVerified: false,
        }),
      }

      const twoAccounts = {
        findById: vi.fn().mockResolvedValue({
          id: 'account-1',
          userId: 'user-1',
          gmailConnected: true,
          accountLast4: '1234',
        }),
        findByUserId: vi.fn().mockResolvedValue([
          { id: 'account-1', accountLast4: '1234' },
          { id: 'account-2', accountLast4: '8802' },
        ]),
      }

      it('files the row against the account the bank named, not the one the job carried', async () => {
        // The webhook queues one job per connected account for the same
        // notification, so the job id is a race winner rather than an answer.
        const { deps } = makeDeps({
          aiUniversalParser: namingSecondAccount,
          accountRepo: twoAccounts,
        })
        const worker = new EmailIngestWorker(deps)
        await (worker as any).processJob({
          name: 'ingest-message',
          data: { userId: 'user-1', messageId: 'msg-attribution' },
        } as any)

        expect(deps.transactionRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({ accountId: 'account-2' }),
        )
      })

      it('records nothing when the alert names no account and the user has several', async () => {
        // There is no job account to fall back on any more, and that is the
        // fix rather than a gap. Inventing one files money against an account
        // the bank never named, which is invisible once written: amounts and
        // monthly totals still look right, and only per-account balances
        // quietly stop agreeing with the bank.
        const { deps } = makeDeps({ accountRepo: twoAccounts })
        const worker = new EmailIngestWorker(deps)
        await (worker as any).processJob({
          name: 'ingest-message',
          data: { userId: 'user-1', messageId: 'msg-no-mask' },
        } as any)

        expect(deps.transactionRepo.create).not.toHaveBeenCalled()
      })

      it('records against the only account when the alert names none', async () => {
        // One account and no stated number is a deduction, not a guess —
        // there is nothing else the alert could be about. This is the ordinary
        // case for someone who has connected a single bank.
        const oneAccount = {
          findById: vi.fn().mockResolvedValue({ id: 'account-1', userId: 'user-1', accountLast4: '1234' }),
          findByUserId: vi.fn().mockResolvedValue([{ id: 'account-1', accountLast4: '1234' }]),
        }
        const { deps } = makeDeps({ accountRepo: oneAccount })
        const worker = new EmailIngestWorker(deps)
        await (worker as any).processJob({
          name: 'ingest-message',
          data: { userId: 'user-1', messageId: 'msg-no-mask' },
        } as any)

        expect(deps.transactionRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({ accountId: 'account-1' }),
        )
      })
    })

    describe('trust in a hand-written parser', () => {
      /** A parser that returns a perfectly plausible transaction. */
      function parserDeclaring(validatedAgainstRealMail: boolean) {
        return {
          parserId: 'p-1',
          bankName: 'Test Bank',
          supportedDomains: ['testbank.test'],
          validatedAgainstRealMail,
          parse: vi.fn().mockResolvedValue({
            merchantName: 'POS Purchase',
            amountKobo: 100000n,
            type: 'DEBIT',
            transactionDate: new Date(),
          }),
        }
      }

      it('does not mark a parse verified when the parser has never seen real mail', async () => {
        // The regression that matters. Trust used to be inferred from the parse
        // simply having returned something, which handed the highest confidence
        // in the system to nine parsers written against an invented format.
        const parser = parserDeclaring(false)
        const { deps } = makeDeps({
          parserRegistry: { getParserForDomain: vi.fn().mockReturnValue(parser) },
        })
        const worker = new EmailIngestWorker(deps)
        await (worker as any).processJob({
          name: 'ingest-message',
          data: { userId: 'user-1', messageId: 'msg-unvalidated' },
        } as any)

        // Both assertions are needed. The AI fallback also yields
        // isVerified: false, so without proving the static parser actually ran
        // this would pass even if the hand-written path were skipped entirely.
        expect(parser.parse).toHaveBeenCalled()
        expect(deps.transactionRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({ isVerified: false }),
        )
      })

      it('marks it verified when the parser has been checked against real mail', async () => {
        const { deps } = makeDeps({
          parserRegistry: { getParserForDomain: vi.fn().mockReturnValue(parserDeclaring(true)) },
        })
        const worker = new EmailIngestWorker(deps)
        await (worker as any).processJob({
          name: 'ingest-message',
          data: { userId: 'user-1', messageId: 'msg-validated' },
        } as any)

        expect(deps.transactionRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({ isVerified: true }),
        )
      })
    })

    describe('the bank reference', () => {
      /** A parsed alert that states the bank's own transaction id. */
      function withReference(reference: string) {
        return {
          parse: vi.fn().mockResolvedValue({
            tx: {
              merchantName: 'POS Purchase',
              amountKobo: 100000n,
              type: 'DEBIT',
              transactionDate: new Date(),
              balanceAfterKobo: 500000n,
              reference,
            },
            isVerified: false,
          }),
        }
      }

      it('suppresses an alert whose reference is already recorded', async () => {
        // The exact answer, and the one the 36-hour matching window cannot
        // give: a redelivery days later under a new message id still resolves.
        const { deps, mockEmailAccessLogRepo } = makeDeps({
          aiUniversalParser: withReference('REF00000001'),
          transactionRepo: {
            create: vi.fn(),
            findByIdempotencyKey: vi.fn().mockResolvedValue(null),
            findByProviderRef: vi.fn().mockResolvedValue([
              { id: 'existing-1', amountKobo: '100000', type: 'DEBIT', source: 'EMAIL', categoryId: 'c1' },
            ]),
            findMatchCandidates: vi.fn().mockResolvedValue([]),
            supersede: vi.fn(),
          },
        })
        await (new EmailIngestWorker(deps) as any).processJob(mockJob)

        expect(deps.transactionRepo.create).not.toHaveBeenCalled()
        expect(mockEmailAccessLogRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'DUPLICATE_SUPPRESSED' }),
        )
      })

      it('supersedes a placeholder identified by reference', async () => {
        const { deps } = makeDeps({
          aiUniversalParser: withReference('REF00000001'),
          transactionRepo: {
            create: vi.fn(),
            findByIdempotencyKey: vi.fn().mockResolvedValue(null),
            findByProviderRef: vi.fn().mockResolvedValue([
              { id: 'placeholder-1', amountKobo: '100000', type: 'DEBIT', source: 'MANUAL', categoryId: 'chosen' },
            ]),
            findMatchCandidates: vi.fn().mockResolvedValue([]),
            supersede: vi.fn().mockResolvedValue({ id: 'placeholder-1' }),
          },
        })
        await (new EmailIngestWorker(deps) as any).processJob(mockJob)

        expect(deps.transactionRepo.create).not.toHaveBeenCalled()
        expect(deps.transactionRepo.supersede).toHaveBeenCalledWith(
          'placeholder-1',
          expect.objectContaining({ providerRef: 'REF00000001', categoryId: 'chosen' }),
        )
      })

      it('refuses to trust a reference attached to a different amount', async () => {
        // How a reference pattern actually fails: it latches onto something
        // CONSTANT in the template. A constant would be shared by every alert
        // from that bank, so unrelated payments would start collapsing into
        // one another. A row carrying it with a different amount is proof the
        // value is not an identifier, and it is dropped rather than acted on.
        const { deps } = makeDeps({
          aiUniversalParser: withReference('TEMPLATE-CONSTANT-9'),
          transactionRepo: {
            create: vi.fn().mockResolvedValue({ id: 'tx-new' }),
            findByIdempotencyKey: vi.fn().mockResolvedValue(null),
            findByProviderRef: vi.fn().mockResolvedValue([
              { id: 'unrelated', amountKobo: '999999', type: 'DEBIT', source: 'EMAIL', categoryId: 'c1' },
            ]),
            findMatchCandidates: vi.fn().mockResolvedValue([]),
            supersede: vi.fn(),
          },
        })
        await (new EmailIngestWorker(deps) as any).processJob(mockJob)

        // The transaction is still recorded — the alert is real, only the
        // reference was not — and the bad value never reaches the table.
        expect(deps.transactionRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({ providerRef: undefined }),
        )
      })
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
