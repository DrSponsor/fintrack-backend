import type { AppFastifyInstance } from '../../../types/fastify'
import { authenticate, requireUser } from '../../../core/middleware/authenticate'
import { CreateBudgetUseCase } from '../use-cases/create-budget.use-case'
import { ListBudgetsUseCase } from '../use-cases/list-budgets.use-case'
import { UpdateBudgetUseCase } from '../use-cases/update-budget.use-case'
import { DeleteBudgetUseCase } from '../use-cases/delete-budget.use-case'
import { PrismaBudgetRepository } from '../repositories/budget.repo'
import { PrismaCategoryRepository } from '../../categories/repositories/category.repo'
import {
  createBudgetBodySchema,
  createBudgetJsonSchema,
  listBudgetsJsonSchema,
  updateBudgetBodySchema,
  updateBudgetJsonSchema,
  deleteBudgetJsonSchema,
} from '../schemas/budget.schemas'
import { successEnvelope } from '../../../core/http/envelope'

export function registerBudgetRoutes(fastify: AppFastifyInstance): void {
  const budgetRepo = new PrismaBudgetRepository(fastify.db.primary)
  const categoryRepo = new PrismaCategoryRepository(fastify.db.primary)

  const createBudgetUseCase = new CreateBudgetUseCase({ budgetRepo, categoryRepo })
  const listBudgetsUseCase = new ListBudgetsUseCase({ budgetRepo })
  const updateBudgetUseCase = new UpdateBudgetUseCase({ budgetRepo })
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
      requireUser(request).sub,
      requireUser(request).tier,
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
    const budgets = await listBudgetsUseCase.execute(requireUser(request).sub)
    return reply.code(200).send(successEnvelope(budgets, request.requestId))
  })

  // ── PATCH /v1/budgets/:id ──────────────────────────────────────
  fastify.patch('/v1/budgets/:id', {
    schema: updateBudgetJsonSchema,
    preHandler: [authenticate],
    config: {
      financialMutation: true,
      audit: { action: 'update_budget', resourceType: 'budget' },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = updateBudgetBodySchema.parse(request.body)
    const budget = await updateBudgetUseCase.execute(
      requireUser(request).sub,
      id,
      { limitKobo: BigInt(parsed.limitKobo) },
    )
    return reply.code(200).send(successEnvelope(budget, request.requestId))
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
    await deleteBudgetUseCase.execute(requireUser(request).sub, id)
    return reply.code(200).send(successEnvelope({ message: 'Budget deleted successfully' }, request.requestId))
  })
}
