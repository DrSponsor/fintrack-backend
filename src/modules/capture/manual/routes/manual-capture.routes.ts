import type { FastifyInstance } from 'fastify'
import { ManualCaptureUseCase } from '../services/manual-capture.use-case'
import { PrismaTransactionRepository } from '../../../transactions/repositories/transaction.repo'
import { PrismaAccountRepository } from '../../../accounts/repositories/account.repo'
import { NormalizerService } from '../../../transactions/services/normalizer.service'
import { CategorizerService } from '../../../transactions/services/categorizer.service'
import { DeduplicatorService } from '../../../transactions/services/deduplicator.service'
import { PrismaCategorizationRepository } from '../../../transactions/repositories/categorization.repo'
import { DeepSeekProvider } from '../../../../core/ai/deepseek.provider'
import { authenticate } from '../../../../core/middleware/authenticate'
import { successEnvelope } from '../../../../core/http/envelope'
import { manualCaptureJsonSchema } from '../schemas/manual-capture.schemas'

export function registerManualCaptureRoutes(
  fastify: FastifyInstance<any, any, any, any, any>,
  categoriesMap: ReadonlyMap<string, string>,
): void {
  const transactionRepo = new PrismaTransactionRepository(fastify.db.primary)
  const accountRepo = new PrismaAccountRepository(fastify.db.primary)
  const mappingRepo = new PrismaCategorizationRepository(fastify.db.primary)
  const normalizer = new NormalizerService()

  const aiProvider = new DeepSeekProvider({
    apiKey: fastify.appConfig.deepseekApiKey ?? '',
    categoriesMap,
  })

  const categorizer = new CategorizerService({
    mappingRepo,
    aiProvider,
    redis: fastify.redis,
    logger: fastify.log,
  })

  const deduplicator = new DeduplicatorService({
    redis: fastify.redis,
  })

  const manualCaptureUseCase = new ManualCaptureUseCase({
    transactionRepo,
    accountRepo,
    normalizer,
    categorizer,
    deduplicator,
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
      const transaction = await manualCaptureUseCase.execute(
        request.user!.sub,
        request.user!.tier,
        request.body,
        request.idempotency!.key,
      )

      return reply.code(201).send(successEnvelope(transaction, request.requestId))
    },
  )
}
