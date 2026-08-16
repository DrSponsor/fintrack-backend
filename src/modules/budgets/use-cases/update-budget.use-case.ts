import type { IBudgetRepository, BudgetRecord } from '../repositories/budget.repo'
import { notFound } from '../../../core/errors/factories'

export type UpdateBudgetInput = {
  readonly limitKobo: bigint
}

export type UpdateBudgetUseCaseDeps = {
  readonly budgetRepo: IBudgetRepository
}

export class UpdateBudgetUseCase {
  private readonly budgetRepo: IBudgetRepository

  public constructor(deps: UpdateBudgetUseCaseDeps) {
    this.budgetRepo = deps.budgetRepo
  }

  public async execute(
    userId: string,
    budgetId: string,
    data: UpdateBudgetInput,
  ): Promise<BudgetRecord> {
    const budget = await this.budgetRepo.findById(budgetId)
    if (!budget) {
      throw notFound(`Budget with ID ${budgetId} not found`)
    }

    // Security check: Return 404, not 403, to avoid confirming existence of resource to unauthorized users
    if (budget.userId !== userId) {
      throw notFound(`Budget with ID ${budgetId} not found`)
    }

    return this.budgetRepo.update(budgetId, { limitKobo: data.limitKobo })
  }
}
