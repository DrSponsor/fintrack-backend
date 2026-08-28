import type { AppFastifyInstance } from '../../../../types/fastify'
import { ManualCaptureUseCase } from '../services/manual-capture.use-case'
import { PrismaTransactionRepository } from '../../../transactions/repositories/transaction.repo'
import { PrismaAccountRepository } from '../../../accounts/repositories/account.repo'
import { PrismaCategoryRepository } from '../../../categories/repositories/category.repo'
import { NormalizerService } from '../../../transactions/services/normalizer.service'
import { CategorizerService } from '../../../transactions/services/categorizer.service'
import { ReconciliationService } from '../../../transactions/services/reconciliation.service'
import { PrismaCategorizationRepository } from '../../../transactions/repositories/categorization.repo'
import { createAIProvider } from '../../../../core/ai/create-provider'
import { authenticate, requireUser } from '../../../../core/middleware/authenticate'
import { successEnvelope } from '../../../../core/http/envelope'
import { manualCaptureJsonSchema } from '../schemas/manual-capture.schemas'
import { TransferMatcherService } from '../../../transactions/services/transfer-matcher.service'
import { PrismaTransferRepository } from '../../../transactions/repositories/transfer.repo'

export function registerManualCaptureRoutes(
  fastify: AppFastifyInstance,
  categoriesMap: ReadonlyMap<string, string>,
): void {
  const transactionRepo = new PrismaTransactionRepository(fastify.db.primary)
  const accountRepo = new PrismaAccountRepository(fastify.db.primary)
  const categoryRepo = new PrismaCategoryRepository(fastify.db.primary)
  const mappingRepo = new PrismaCategorizationRepository(fastify.db.primary)
  const normalizer = new NormalizerService()

  const aiProvider = createAIProvider(fastify.appConfig, categoriesMap)

  const categorizer = new CategorizerService({
    mappingRepo,
    aiProvider,
    redis: fastify.redis,
    logger: fastify.log,
  })

  const reconciliation = new ReconciliationService({ logger: fastify.log })

  const manualCaptureUseCase = new ManualCaptureUseCase({
    transactionRepo,
    accountRepo,
    categoryRepo,
    normalizer,
    categorizer,
    reconciliation,
    transferMatcher: new TransferMatcherService({
      repo: new PrismaTransferRepository(fastify.db.primary),
      logger: fastify.log,
    }),
    logger: fastify.log,
  })

  fastify.post(
    '/v1/capture/manual',
    {
      schema: manualCaptureJsonSchema,
      preHandler: [authenticate],
      config: {
        financialMutation: true,
        audit: { action: 'manual_capture', resourceType: 'transaction' },
      },
    },
    async (request, reply) => {
      if (request.idempotency === undefined) {
        throw new Error('manual capture route reached without idempotency preHandler running')
      }

      const result = await manualCaptureUseCase.execute(
        requireUser(request).sub,
        requireUser(request).tier,
        request.body,
        request.idempotency.key,
      )

      // 201 only when a row was created. Note that the idempotency plugin
      // caches whatever goes out here against the Idempotency-Key, so a client
      // re-sending with force must mint a NEW key — replaying the old one
      // replays this same "duplicate suspected" answer instead of recording
      // anything.
      const status = result.outcome === 'recorded' ? 201 : 200
      return reply.code(status).send(successEnvelope(result, request.requestId))
    },
  )
}
