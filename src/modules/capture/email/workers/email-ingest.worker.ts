import type { ConnectionOptions, Job, Queue } from 'bullmq'
import { BaseWorker } from '../../../../core/queue/base-worker'
import { QUEUE_NAMES } from '../../../../core/queue/queues'
import type { PrismaClient } from '../../../../generated/prisma/client'
import type { IAccountRepository } from '../../../accounts/repositories/account.repo'
import type { ITransactionRepository } from '../../../transactions/repositories/transaction.repo'
import type { OAuthService } from '../services/oauth.service'
import { GmailQuotaExhaustedError } from '../services/fetch.service'
import type { FetchService, GmailEmailDetails } from '../services/fetch.service'
import type { SafetyFilterService } from '../services/safety-filter.service'
import type { ParserRegistryService } from '../services/parser-registry.service'
import type { AIUniversalParser } from '../parsers/ai-universal.parser'
import type { ParsedTransaction } from '../parsers/parser.interface'
import type { DiscoveryService } from '../services/discovery.service'
import type { NormalizerService } from '../../../transactions/services/normalizer.service'
import type { CategorizerService } from '../../../transactions/services/categorizer.service'
import type { DeduplicatorService } from '../../../transactions/services/deduplicator.service'
import type { AppLogger } from '../../../../core/logger'

export type EmailIngestJobData =
  | { readonly accountId: string; readonly messageId: string }
  | { readonly accountId: string; readonly historyId: string }

export type EmailIngestWorkerDeps = {
  readonly connection: ConnectionOptions
  readonly concurrency: number
  readonly prisma: PrismaClient
  readonly accountRepo: IAccountRepository
  readonly transactionRepo: ITransactionRepository
  readonly oauthService: OAuthService
  readonly fetchService: FetchService
  readonly safetyFilter: SafetyFilterService
  readonly parserRegistry: ParserRegistryService
  readonly aiUniversalParser: AIUniversalParser
  readonly discoveryService: DiscoveryService
  readonly normalizer: NormalizerService
  readonly categorizer: CategorizerService
  readonly deduplicator: DeduplicatorService
  readonly logger: AppLogger
  readonly captureEmailQueue: Queue
}

export class EmailIngestWorker extends BaseWorker<EmailIngestJobData, void> {
  private readonly prisma: PrismaClient
  private readonly accountRepo: IAccountRepository
  private readonly transactionRepo: ITransactionRepository
  private readonly oauthService: OAuthService
  private readonly fetchService: FetchService
  private readonly safetyFilter: SafetyFilterService
  private readonly parserRegistry: ParserRegistryService
  private readonly aiUniversalParser: AIUniversalParser
  private readonly discoveryService: DiscoveryService
  private readonly normalizer: NormalizerService
  private readonly categorizer: CategorizerService
  private readonly deduplicator: DeduplicatorService
  private readonly logger: AppLogger
  private readonly captureEmailQueue: Queue

  public constructor(deps: EmailIngestWorkerDeps) {
    super({
      queueName: QUEUE_NAMES.captureEmail,
      connection: deps.connection,
      concurrency: deps.concurrency,
      logger: deps.logger,
      processor: (job) => this.processJob(job),
    })

    this.prisma = deps.prisma
    this.accountRepo = deps.accountRepo
    this.transactionRepo = deps.transactionRepo
    this.oauthService = deps.oauthService
    this.fetchService = deps.fetchService
    this.safetyFilter = deps.safetyFilter
    this.parserRegistry = deps.parserRegistry
    this.aiUniversalParser = deps.aiUniversalParser
    this.discoveryService = deps.discoveryService
    this.normalizer = deps.normalizer
    this.categorizer = deps.categorizer
    this.deduplicator = deps.deduplicator
    this.logger = deps.logger
    this.captureEmailQueue = deps.captureEmailQueue
  }

  private async processJob(job: Job<any, void, string>): Promise<void> {
    if (job.name === 'cleanup-raw-snippets') {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      this.logger.info({ cutoff }, 'Starting raw transaction snippet cleanup job...')
      const updated = await this.prisma.transaction.updateMany({
        where: {
          rawSnippetEnc: { not: null },
          createdAt: { lt: cutoff },
        },
        data: {
          rawSnippetEnc: null,
        },
      })
      this.logger.info({ count: updated.count }, 'Raw transaction snippet cleanup job complete.')
      return
    }

    if (job.name === 'sync-history') {
      const { accountId, historyId } = job.data as { accountId: string; historyId: string }
      
      const account = await this.accountRepo.findById(accountId)
      if (account === null) {
        this.logger.warn({ accountId, historyId }, 'Account not found for history sync job. Aborting.')
        return
      }

      if (!account.gmailConnected) {
        this.logger.info({ accountId, historyId }, 'Account Gmail connection is disabled. Skipping.')
        return
      }

      let accessToken: string
      try {
        accessToken = await this.oauthService.getValidAccessToken(accountId)
      } catch (err) {
        this.logger.error({ err, accountId, historyId }, 'Failed to retrieve Google OAuth access token for history sync')
        return
      }

      try {
        await this.discoveryService.syncHistory(
          accountId,
          historyId,
          accessToken,
          account.lastTransactionDate,
        )
      } catch (err) {
        this.logger.error({ err, accountId, historyId }, 'Error executing history sync')
        throw err
      }
      return
    }

    // Default job: ingest-message
    const { accountId, messageId } = job.data as { accountId: string; messageId: string }

    // 1. Fetch account and verify Gmail connection is active
    const account = await this.accountRepo.findById(accountId)
    if (account === null) {
      this.logger.warn({ accountId, messageId }, 'Account not found for ingestion job. Aborting.')
      return
    }

    if (!account.gmailConnected) {
      this.logger.info({ accountId, messageId }, 'Account Gmail connection is disabled. Skipping.')
      return
    }

    // 2. Refresh / retrieve access token
    let accessToken: string
    try {
      accessToken = await this.oauthService.getValidAccessToken(accountId)
    } catch (err) {
      this.logger.error({ err, accountId, messageId }, 'Failed to retrieve Google OAuth access token for ingestion')
      return // Token was invalid or revoked, user was marked disconnected.
    }

    // 3. Fetch message content from Gmail API
    let email: GmailEmailDetails
    try {
      email = await this.fetchService.fetchEmailWithBackoff(messageId, accessToken)
    } catch (err) {
      if (err instanceof GmailQuotaExhaustedError) {
        this.logger.warn({ messageId, accountId }, 'Gmail API quota limit hit. Deferring job by 2 hours.')
        await this.captureEmailQueue.add(
          job.name,
          job.data,
          {
            delay: 2 * 60 * 60 * 1000,
            jobId: `quota:${messageId}`,
          },
        )
        return // Successfully handled, do not consume retry budget
      }
      throw err // Bubble up to let BullMQ handle retry for transient network issues
    }

    // 4. Run through the Safety Gate filters
    if (this.safetyFilter.shouldDiscard(email.subject, email.bodyText)) {
      this.logger.info({ messageId, subject: email.subject }, 'Email discarded by safety gate (OTP/security keyword)')
      return
    }

    if (!this.safetyFilter.hasTransactionKeywords(email.subject, email.bodyText)) {
      this.logger.info({ messageId, subject: email.subject }, 'Email discarded silently (no transaction keywords found)')
      return
    }

    // 5. Run Parser Registry matching
    let parsedTx: ParsedTransaction | null = null
    let isVerified = false

    const staticParser = this.parserRegistry.getParserForDomain(email.senderDomain)
    if (staticParser !== null) {
      parsedTx = await staticParser.parse(email.subject, email.bodyHtml, email.bodyText)
      isVerified = true
    } else {
      const aiResult = await this.aiUniversalParser.parse(
        email.senderDomain,
        email.subject,
        email.bodyHtml,
        email.bodyText,
      )
      parsedTx = aiResult.tx
      isVerified = aiResult.isVerified
    }

    if (parsedTx === null) {
      this.logger.warn({ messageId, senderDomain: email.senderDomain }, 'Failed to parse transaction from email')
      return
    }

    // 6. Normalization
    const normalizedName = this.normalizer.normalizeMerchantName(parsedTx.merchantName)
    const fingerprint = this.normalizer.getMerchantFingerprint(normalizedName)

    // 7. Deduplication
    const hash = this.deduplicator.getTransactionHash(
      account.accountLast4,
      parsedTx.amountKobo,
      parsedTx.transactionDate,
    )
    const duplicateId = await this.deduplicator.findDuplicate(hash)
    if (duplicateId !== null) {
      this.logger.info({ messageId, duplicateId, hash }, 'Duplicate transaction detected in deduplicator and suppressed')
      return
    }

    // Load user tier to compute category
    const user = await this.prisma.user.findUnique({
      where: { id: account.userId },
      select: { tier: true },
    })
    const userTier = user?.tier ?? 'FREE'

    // 8. Categorization
    const categoryId = await this.categorizer.categorize(
      account.userId,
      userTier,
      normalizedName,
      parsedTx.amountKobo,
      fingerprint,
    )

    // 9. DB Write (atomic, PgBouncer-safe transaction)
    try {
      const transaction = await this.transactionRepo.create({
        accountId,
        amountKobo: parsedTx.amountKobo,
        type: parsedTx.type,
        merchantName: normalizedName,
        categoryId,
        transactionDate: parsedTx.transactionDate,
        source: 'EMAIL',
        idempotencyKey: messageId, // idempotencyKey = Gmail message ID
        balanceAfterKobo: parsedTx.balanceAfterKobo,
        isVerified,
      })

      // 10. Track in deduplication cache
      await this.deduplicator.trackTransaction(hash, transaction.id)
      
      this.logger.info(
        { messageId, transactionId: transaction.id, senderDomain: email.senderDomain },
        'Email transaction successfully ingested',
      )
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'P2002') {
        // Unique key constraint violation: transaction was already written concurrently
        this.logger.info({ messageId }, 'Deduplicated transaction at database layer (unique idempotencyKey)')
        return
      }
      throw err
    }
  }
}
