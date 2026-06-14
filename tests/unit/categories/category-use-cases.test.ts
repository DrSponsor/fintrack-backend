import { describe, expect, it, vi } from 'vitest'
import { ListCategoriesUseCase } from '../../../src/modules/categories/use-cases/list-categories.use-case'
import type { ICategoryRepository, CategoryRecord } from '../../../src/modules/categories/repositories/category.repo'

function createMockCategoryRepo(categories: readonly CategoryRecord[] = []): ICategoryRepository {
  return {
    findAll: vi.fn().mockResolvedValue(categories),
    findById: vi.fn().mockResolvedValue(null),
  }
}

describe('ListCategoriesUseCase', () => {
  it('returns all categories from the repository', async () => {
    const categories: readonly CategoryRecord[] = [
      { id: '1', name: 'food-groceries', icon: 'utensils' },
      { id: '2', name: 'transport', icon: 'bus' },
    ]
    const categoryRepo = createMockCategoryRepo(categories)
    const useCase = new ListCategoriesUseCase({ categoryRepo })
    const result = await useCase.execute()

    expect(result).toEqual(categories)
    expect(categoryRepo.findAll).toHaveBeenCalledOnce()
  })
})
