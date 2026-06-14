import type { FastifyInstance } from 'fastify'
import {
  ListTransactionsUseCase,
  GetTransactionUseCase,
  CorrectCategoryUseCase,
} from '../use-cases/transaction.use-cases'
import { PrismaTransactionRepository } from '../repositories/transaction.repo'
import { PrismaCategoryRepository } from '../../categories/repositories/category.repo'
import { NormalizerService } from '../services/normalizer.service'
import { authenticate } from '../../../core/middleware/authenticate'
import { successEnvelope } from '../../../core/http/envelope'
import {
  listTransactionsJsonSchema,
  getTransactionJsonSchema,
  correctCategoryJsonSchema,
} from '../schemas/transaction.schemas'

export function registerTransactionRoutes(fastify: FastifyInstance<any, any, any, any, any>): void {
  const transactionRepo = new PrismaTransactionRepository(fastify.db.primary)
  const categoryRepo = new PrismaCategoryRepository(fastify.db.primary)
  const normalizer = new NormalizerService()

  const listTransactionsUseCase = new ListTransactionsUseCase({ transactionRepo })
  const getTransactionUseCase = new GetTransactionUseCase({ transactionRepo })
  const correctCategoryUseCase = new CorrectCategoryUseCase({
    transactionRepo,
    categoryRepo,
    normalizer,
    logger: fastify.log,
  })

  // ── GET /v1/transactions ──────────────────────────────────────────
  fastify.get(
    '/v1/transactions',
    {
      schema: listTransactionsJsonSchema,
      preHandler: [authenticate],
    },
    async (request, reply) => {
      const userId = request.user!.sub
      const result = await listTransactionsUseCase.execute(userId, request.query)

      const lastItem = result.data[result.data.length - 1]
      const nextCursor = lastItem !== undefined ? lastItem.id : undefined

      return reply.code(200).send(
        successEnvelope(result.data, request.requestId, {
          cursor: nextCursor,
          hasMore: result.hasMore,
        }),
      );
    },
  )

  // ── GET /v1/transactions/:id ──────────────────────────────────────
  fastify.get(
    '/v1/transactions/:id',
    {
      schema: getTransactionJsonSchema,
      preHandler: [authenticate],
    },
    async (request, reply) => {
      const userId = request.user!.sub
      const { id } = request.params as { id: string }
      const transaction = await getTransactionUseCase.execute(userId, id)

      return reply.code(200).send(successEnvelope(transaction, request.requestId))
    },
  )

  // ── PATCH /v1/transactions/:id/category ───────────────────────────
  fastify.patch(
    '/v1/transactions/:id/category',
    {
      schema: correctCategoryJsonSchema,
      preHandler: [authenticate],
      config: {
        audit: { action: 'correct_category', resourceType: 'transaction' },
      },
    },
    async (request, reply) => {
      const userId = request.user!.sub
      const { id } = request.params as { id: string }
      await correctCategoryUseCase.execute(userId, id, request.body)

      return reply.code(200).send(
        successEnvelope({ message: 'Transaction category corrected successfully' }, request.requestId),
      )
    },
  )
}
