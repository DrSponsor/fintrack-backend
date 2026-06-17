import type { IBudgetRepository } from '../repositories/budget.repo'
import { notFound } from '../../../core/errors/factories'

export type DeleteBudgetUseCaseDeps = {
  readonly budgetRepo: IBudgetRepository
}

export class DeleteBudgetUseCase {
  private readonly budgetRepo: IBudgetRepository

  public constructor(deps: DeleteBudgetUseCaseDeps) {
    this.budgetRepo = deps.budgetRepo
  }

  public async execute(userId: string, budgetId: string): Promise<void> {
    const budget = await this.budgetRepo.findById(budgetId)
    if (!budget) {
      throw notFound(`Budget with ID ${budgetId} not found`)
    }

    // Security check: Return 404, not 403, to avoid confirming existence of resource to unauthorized users
    if (budget.userId !== userId) {
      throw notFound(`Budget with ID ${budgetId} not found`)
    }

    await this.budgetRepo.delete(budgetId)
  }
}
