import type { IBudgetRepository, BudgetRecord } from '../repositories/budget.repo'

export type ListBudgetsUseCaseDeps = {
  readonly budgetRepo: IBudgetRepository
}

export class ListBudgetsUseCase {
  private readonly budgetRepo: IBudgetRepository

  public constructor(deps: ListBudgetsUseCaseDeps) {
    this.budgetRepo = deps.budgetRepo
  }

  public async execute(userId: string): Promise<readonly BudgetRecord[]> {
    return this.budgetRepo.findByUser(userId)
  }
}
