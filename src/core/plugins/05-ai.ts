import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { DeepSeekProvider } from '../ai/deepseek.provider'

export const aiPlugin = fp(async (fastify: FastifyInstance) => {
  // 1. Fetch categories to build name -> id map for AI categorization
  const categories = await fastify.db.primary.category.findMany({
    select: { id: true, name: true },
  })

  const categoriesMap = new Map<string, string>(
    categories.map((c) => [c.name.toLowerCase().trim(), c.id]),
  )

  // 2. Instantiate DeepSeekProvider as a singleton decorated onto fastify.ai
  const aiProvider = new DeepSeekProvider({
    apiKey: fastify.appConfig.deepseekApiKey ?? '',
    categoriesMap,
  })

  fastify.decorate('ai', aiProvider)
}, {
  name: '05-ai',
  dependencies: ['04-database'],
})
