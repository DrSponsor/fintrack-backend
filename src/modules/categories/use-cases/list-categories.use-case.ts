import type { ICategoryRepository, CategoryRecord } from '../repositories/category.repo'

export type ListCategoriesUseCaseDeps = {
  readonly categoryRepo: ICategoryRepository
}

export class ListCategoriesUseCase {
  private readonly categoryRepo: ICategoryRepository

  public constructor(deps: ListCategoriesUseCaseDeps) {
    this.categoryRepo = deps.categoryRepo
  }

  public async execute(): Promise<readonly CategoryRecord[]> {
    return this.categoryRepo.findAll()
  }
}
