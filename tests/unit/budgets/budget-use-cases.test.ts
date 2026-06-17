import { describe, expect, it, vi } from 'vitest'
import { CreateBudgetUseCase } from '../../../src/modules/budgets/use-cases/create-budget.use-case'
import { ListBudgetsUseCase } from '../../../src/modules/budgets/use-cases/list-budgets.use-case'
import { DeleteBudgetUseCase } from '../../../src/modules/budgets/use-cases/delete-budget.use-case'
import type { IBudgetRepository, BudgetRecord } from '../../../src/modules/budgets/repositories/budget.repo'
import type { ICategoryRepository, CategoryRecord } from '../../../src/modules/categories/repositories/category.repo'

function createMockCategoryRepo(category: CategoryRecord | null = null): ICategoryRepository {
  return {
    findAll: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(category),
  }
}

function createMockBudgetRepo(options: {
  createResult?: BudgetRecord
  findByIdResult?: BudgetRecord | null
  findByUserResult?: readonly BudgetRecord[]
  findByCategoryAndPeriodResult?: readonly BudgetRecord[]
} = {}): IBudgetRepository {
  return {
    create: vi.fn().mockResolvedValue(options.createResult ?? {} as BudgetRecord),
    findById: vi.fn().mockResolvedValue(options.findByIdResult ?? null),
    findByUser: vi.fn().mockResolvedValue(options.findByUserResult ?? []),
    findByCategoryAndPeriod: vi.fn().mockResolvedValue(options.findByCategoryAndPeriodResult ?? []),
    findByCategory: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    createAlert: vi.fn().mockResolvedValue(undefined),
    getAlertCount: vi.fn().mockResolvedValue(0),
    getSpentKobo: vi.fn().mockResolvedValue(0n),
  }
}

describe('Budgets Use Cases', () => {
  describe('CreateBudgetUseCase', () => {
    it('throws 404 when category does not exist', async () => {
      const categoryRepo = createMockCategoryRepo(null)
      const budgetRepo = createMockBudgetRepo()
      const useCase = new CreateBudgetUseCase({ budgetRepo, categoryRepo })

      await expect(
        useCase.execute('user-1', 'FREE', {
          categoryId: 'cat-1',
          limitKobo: 50000n,
          periodType: 'MONTHLY',
        }),
      ).rejects.toThrowError('Category with ID cat-1 not found')
    })

    it('throws 409 conflict when duplicate budget already exists', async () => {
      const category: CategoryRecord = { id: 'cat-1', name: 'Food', icon: 'food' }
      const categoryRepo = createMockCategoryRepo(category)
      const budget: BudgetRecord = {
        id: 'b-1',
        userId: 'user-1',
        categoryId: 'cat-1',
        limitKobo: '50000',
        periodType: 'MONTHLY',
        createdAt: new Date(),
      }
      const budgetRepo = createMockBudgetRepo({
        findByCategoryAndPeriodResult: [budget],
      })
      const useCase = new CreateBudgetUseCase({ budgetRepo, categoryRepo })

      await expect(
        useCase.execute('user-1', 'FREE', {
          categoryId: 'cat-1',
          limitKobo: 50000n,
          periodType: 'MONTHLY',
        }),
      ).rejects.toThrowError('A monthly budget already exists for category "Food"')
    })

    it('throws 402 subscriptionRequired when FREE tier user exceeds 3 budgets', async () => {
      const category: CategoryRecord = { id: 'cat-4', name: 'Utilities', icon: 'zap' }
      const categoryRepo = createMockCategoryRepo(category)
      const mockBudgets: readonly BudgetRecord[] = [
        { id: 'b-1', userId: 'user-1', categoryId: 'cat-1', limitKobo: '1000', periodType: 'MONTHLY', createdAt: new Date() },
        { id: 'b-2', userId: 'user-1', categoryId: 'cat-2', limitKobo: '2000', periodType: 'MONTHLY', createdAt: new Date() },
        { id: 'b-3', userId: 'user-1', categoryId: 'cat-3', limitKobo: '3000', periodType: 'MONTHLY', createdAt: new Date() },
      ]
      const budgetRepo = createMockBudgetRepo({
        findByUserResult: mockBudgets,
      })
      const useCase = new CreateBudgetUseCase({ budgetRepo, categoryRepo })

      await expect(
        useCase.execute('user-1', 'FREE', {
          categoryId: 'cat-4',
          limitKobo: 50000n,
          periodType: 'MONTHLY',
        }),
      ).rejects.toThrowError('Free tier is limited to 3 budget categories. Please upgrade to Pro.')
    })

    it('allows > 3 budgets when user is PRO tier', async () => {
      const category: CategoryRecord = { id: 'cat-4', name: 'Utilities', icon: 'zap' }
      const categoryRepo = createMockCategoryRepo(category)
      const mockBudgets: readonly BudgetRecord[] = [
        { id: 'b-1', userId: 'user-1', categoryId: 'cat-1', limitKobo: '1000', periodType: 'MONTHLY', createdAt: new Date() },
        { id: 'b-2', userId: 'user-1', categoryId: 'cat-2', limitKobo: '2000', periodType: 'MONTHLY', createdAt: new Date() },
        { id: 'b-3', userId: 'user-1', categoryId: 'cat-3', limitKobo: '3000', periodType: 'MONTHLY', createdAt: new Date() },
      ]
      const created: BudgetRecord = {
        id: 'b-4',
        userId: 'user-1',
        categoryId: 'cat-4',
        limitKobo: '50000',
        periodType: 'MONTHLY',
        createdAt: new Date(),
      }
      const budgetRepo = createMockBudgetRepo({
        findByUserResult: mockBudgets,
        createResult: created,
      })
      const useCase = new CreateBudgetUseCase({ budgetRepo, categoryRepo })

      const result = await useCase.execute('user-1', 'PRO', {
        categoryId: 'cat-4',
        limitKobo: 50000n,
        periodType: 'MONTHLY',
      })
      expect(result).toEqual(created)
      expect(budgetRepo.create).toHaveBeenCalledOnce()
    })
  })

  describe('ListBudgetsUseCase', () => {
    it('returns budgets of the current user', async () => {
      const mockBudgets: readonly BudgetRecord[] = [
        { id: 'b-1', userId: 'user-1', categoryId: 'cat-1', limitKobo: '1000', periodType: 'MONTHLY', createdAt: new Date() },
      ]
      const budgetRepo = createMockBudgetRepo({
        findByUserResult: mockBudgets,
      })
      const useCase = new ListBudgetsUseCase({ budgetRepo })
      const result = await useCase.execute('user-1')

      expect(result).toEqual(mockBudgets)
      expect(budgetRepo.findByUser).toHaveBeenCalledWith('user-1')
    })
  })

  describe('DeleteBudgetUseCase', () => {
    it('throws 404 if budget does not exist', async () => {
      const budgetRepo = createMockBudgetRepo({ findByIdResult: null })
      const useCase = new DeleteBudgetUseCase({ budgetRepo })

      await expect(useCase.execute('user-1', 'b-1')).rejects.toThrowError('Budget with ID b-1 not found')
    })

    it('throws 404 if budget does not belong to the user', async () => {
      const budget: BudgetRecord = {
        id: 'b-1',
        userId: 'other-user',
        categoryId: 'cat-1',
        limitKobo: '5000',
        periodType: 'MONTHLY',
        createdAt: new Date(),
      }
      const budgetRepo = createMockBudgetRepo({ findByIdResult: budget })
      const useCase = new DeleteBudgetUseCase({ budgetRepo })

      await expect(useCase.execute('user-1', 'b-1')).rejects.toThrowError('Budget with ID b-1 not found')
    })

    it('deletes the budget if it belongs to user', async () => {
      const budget: BudgetRecord = {
        id: 'b-1',
        userId: 'user-1',
        categoryId: 'cat-1',
        limitKobo: '5000',
        periodType: 'MONTHLY',
        createdAt: new Date(),
      }
      const budgetRepo = createMockBudgetRepo({ findByIdResult: budget })
      const useCase = new DeleteBudgetUseCase({ budgetRepo })

      await useCase.execute('user-1', 'b-1')
      expect(budgetRepo.delete).toHaveBeenCalledWith('b-1')
    })
  })
})
