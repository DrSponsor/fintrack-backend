import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../../core/middleware/authenticate'
import { CreateBudgetUseCase } from '../use-cases/create-budget.use-case'
import { ListBudgetsUseCase } from '../use-cases/list-budgets.use-case'
import { DeleteBudgetUseCase } from '../use-cases/delete-budget.use-case'
import { PrismaBudgetRepository } from '../repositories/budget.repo'
import { PrismaCategoryRepository } from '../../categories/repositories/category.repo'
import {
  createBudgetBodySchema,
  createBudgetJsonSchema,
  listBudgetsJsonSchema,
  deleteBudgetJsonSchema,
} from '../schemas/budget.schemas'
import { successEnvelope } from '../../../core/http/envelope'

export function registerBudgetRoutes(fastify: FastifyInstance<any, any, any, any, any>): void {
  const budgetRepo = new PrismaBudgetRepository(fastify.db.primary)
  const categoryRepo = new PrismaCategoryRepository(fastify.db.primary)

  const createBudgetUseCase = new CreateBudgetUseCase({ budgetRepo, categoryRepo })
  const listBudgetsUseCase = new ListBudgetsUseCase({ budgetRepo })
  const deleteBudgetUseCase = new DeleteBudgetUseCase({ budgetRepo })

  // ── POST /v1/budgets ───────────────────────────────────────────
  fastify.post('/v1/budgets', {
    schema: createBudgetJsonSchema,
    preHandler: [authenticate],
    config: {
      financialMutation: true,
      audit: { action: 'create_budget', resourceType: 'budget' },
    },
  }, async (request, reply) => {
    const parsed = createBudgetBodySchema.parse(request.body)
    const budget = await createBudgetUseCase.execute(
      request.user!.sub,
      request.user!.tier,
      {
        categoryId: parsed.categoryId,
        limitKobo: BigInt(parsed.limitKobo),
        periodType: parsed.periodType,
      },
    )
    return reply.code(201).send(successEnvelope(budget, request.requestId))
  })

  // ── GET /v1/budgets ────────────────────────────────────────────
  fastify.get('/v1/budgets', {
    schema: listBudgetsJsonSchema,
    preHandler: [authenticate],
  }, async (request, reply) => {
    const budgets = await listBudgetsUseCase.execute(request.user!.sub)
    return reply.code(200).send(successEnvelope(budgets, request.requestId))
  })

  // ── DELETE /v1/budgets/:id ─────────────────────────────────────
  fastify.delete('/v1/budgets/:id', {
    schema: deleteBudgetJsonSchema,
    preHandler: [authenticate],
    config: {
      financialMutation: true,
      audit: { action: 'delete_budget', resourceType: 'budget' },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    await deleteBudgetUseCase.execute(request.user!.sub, id)
    return reply.code(200).send(successEnvelope({ message: 'Budget deleted successfully' }, request.requestId))
  })
}
