import type { FastifyInstance } from 'fastify'
import { ListCategoriesUseCase } from '../use-cases/list-categories.use-case'
import { PrismaCategoryRepository } from '../repositories/category.repo'
import { listCategoriesJsonSchema } from '../schemas/category.schemas'
import { successEnvelope } from '../../../core/http/envelope'

export function registerCategoryRoutes(fastify: FastifyInstance<any, any, any, any, any>): void {
  const categoryRepo = new PrismaCategoryRepository(fastify.db.primary)
  const listCategoriesUseCase = new ListCategoriesUseCase({ categoryRepo })

  fastify.get('/v1/categories', {
    schema: listCategoriesJsonSchema,
  }, async (request, reply) => {
    const categories = await listCategoriesUseCase.execute()
    return reply.code(200).send(successEnvelope(categories, request.requestId))
  })
}
