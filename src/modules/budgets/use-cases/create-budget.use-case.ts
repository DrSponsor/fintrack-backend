import type { IBudgetRepository, BudgetRecord } from '../repositories/budget.repo'
import type { ICategoryRepository } from '../../categories/repositories/category.repo'
import { notFound, conflict, subscriptionRequired } from '../../../core/errors/factories'

export type CreateBudgetInput = {
  readonly categoryId: string
  readonly limitKobo: bigint
  readonly periodType: 'WEEKLY' | 'MONTHLY'
}

export type CreateBudgetUseCaseDeps = {
  readonly budgetRepo: IBudgetRepository
  readonly categoryRepo: ICategoryRepository
}

export class CreateBudgetUseCase {
  private readonly budgetRepo: IBudgetRepository
  private readonly categoryRepo: ICategoryRepository

  public constructor(deps: CreateBudgetUseCaseDeps) {
    this.budgetRepo = deps.budgetRepo
    this.categoryRepo = deps.categoryRepo
  }

  public async execute(
    userId: string,
    userTier: string,
    data: CreateBudgetInput,
  ): Promise<BudgetRecord> {
    // 1. Verify category exists
    const category = await this.categoryRepo.findById(data.categoryId)
    if (!category) {
      throw notFound(`Category with ID ${data.categoryId} not found`)
    }

    // 2. Check for duplicate budget (same category and period type)
    const existing = await this.budgetRepo.findByCategoryAndPeriod(
      userId,
      data.categoryId,
      data.periodType,
    )
    if (existing.length > 0) {
      throw conflict(`A ${data.periodType.toLowerCase()} budget already exists for category "${category.name}"`)
    }

    // 3. Enforce FREE tier limits
    if (userTier !== 'PRO') {
      const userBudgets = await this.budgetRepo.findByUser(userId)
      if (userBudgets.length >= 3) {
        throw subscriptionRequired('Free tier is limited to 3 budget categories. Please upgrade to Pro.')
      }
    }

    // 4. Create budget
    return this.budgetRepo.create({
      userId,
      categoryId: data.categoryId,
      limitKobo: data.limitKobo,
      periodType: data.periodType,
    })
  }
}
