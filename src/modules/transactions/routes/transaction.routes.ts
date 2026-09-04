import type { AppFastifyInstance } from '../../../types/fastify'
import {
  ListTransactionsUseCase,
  GetTransactionUseCase,
  CorrectCategoryUseCase,
  CorrectDateUseCase,
  DeleteTransactionUseCase,
} from '../use-cases/transaction.use-cases'
import { PrismaTransactionRepository } from '../repositories/transaction.repo'
import { PrismaCategoryRepository } from '../../categories/repositories/category.repo'
import { NormalizerService } from '../services/normalizer.service'
import { MerchantConsensusService } from '../services/merchant-consensus.service'
import { PrismaCategorizationRepository } from '../repositories/categorization.repo'
import { authenticate, requireUser } from '../../../core/middleware/authenticate'
import { successEnvelope } from '../../../core/http/envelope'
import {
  listTransactionsJsonSchema,
  getTransactionJsonSchema,
  correctCategoryJsonSchema,
  correctDateJsonSchema,
  deleteTransactionJsonSchema,
} from '../schemas/transaction.schemas'

export function registerTransactionRoutes(fastify: AppFastifyInstance): void {
  const transactionRepo = new PrismaTransactionRepository(fastify.db.primary)
  const categoryRepo = new PrismaCategoryRepository(fastify.db.primary)
  const normalizer = new NormalizerService()

  const listTransactionsUseCase = new ListTransactionsUseCase({ transactionRepo })
  const getTransactionUseCase = new GetTransactionUseCase({ transactionRepo })
  const deleteTransactionUseCase = new DeleteTransactionUseCase({ transactionRepo, logger: fastify.log })
  const consensus = new MerchantConsensusService({
    repo: new PrismaCategorizationRepository(fastify.db.primary),
    logger: fastify.log,
  })

  const correctDateUseCase = new CorrectDateUseCase({
    transactionRepo,
    logger: fastify.log,
  })

  const correctCategoryUseCase = new CorrectCategoryUseCase({
    transactionRepo,
    categoryRepo,
    normalizer,
    logger: fastify.log,
    consensus,
  })

  // ── GET /v1/transactions ──────────────────────────────────────────
  fastify.get(
    '/v1/transactions',
    {
      schema: listTransactionsJsonSchema,
      preHandler: [authenticate],
    },
    async (request, reply) => {
      const userId = requireUser(request).sub
      const result = await listTransactionsUseCase.execute(userId, request.query)

      const lastItem = result.data[result.data.length - 1]
      const nextCursor =
        lastItem !== undefined
          ? `${lastItem.id}_${lastItem.transactionDate.toISOString()}`
          : undefined

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
      const userId = requireUser(request).sub
      const { id } = request.params as { id: string }
      const transaction = await getTransactionUseCase.execute(userId, id)

      return reply.code(200).send(successEnvelope(transaction, request.requestId))
    },
  )

  // ── DELETE /v1/transactions/:id ───────────────────────────────────
  // Only removes transactions the user entered themselves; see
  // DeleteTransactionUseCase for why bank-sourced rows are immutable.
  fastify.delete(
    '/v1/transactions/:id',
    {
      schema: deleteTransactionJsonSchema,
      preHandler: [authenticate],
      config: {
        // The row's own event chain cascades away with it, so this audit entry
        // is the surviving record that the deletion happened.
        audit: { action: 'delete_transaction', resourceType: 'transaction' },
      },
    },
    async (request, reply) => {
      const userId = requireUser(request).sub
      const { id } = request.params as { id: string }
      await deleteTransactionUseCase.execute(userId, id)

      return reply
        .code(200)
        .send(successEnvelope({ message: 'Transaction deleted' }, request.requestId))
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
      const userId = requireUser(request).sub
      const { id } = request.params as { id: string }
      const { scope, backfilled } = await correctCategoryUseCase.execute(userId, id, request.body)

      // The reach and the count are returned, not just "success". A correction
      // that also rewrote eleven earlier rows is something the user should be
      // told about — silently editing history is how a user stops trusting
      // their own ledger.
      return reply.code(200).send(
        successEnvelope(
          { message: 'Transaction category corrected successfully', scope, backfilled },
          request.requestId,
        ),
      )
    },
  )

  // ── PATCH /v1/transactions/:id/date ───────────────────────────────
  fastify.patch(
    '/v1/transactions/:id/date',
    {
      schema: correctDateJsonSchema,
      preHandler: [authenticate],
      config: {
        audit: { action: 'correct_date', resourceType: 'transaction' },
      },
    },
    async (request, reply) => {
      const userId = requireUser(request).sub
      const { id } = request.params as { id: string }
      const moved = await correctDateUseCase.execute(userId, id, request.body)

      return reply.code(200).send(successEnvelope(moved, request.requestId))
    },
  )
}
