import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { registerManualCaptureRoutes } from './manual/routes/manual-capture.routes'

export const captureModuleName = 'capture' as const

const captureModule: FastifyPluginAsync = async (fastify) => {
  // 1. Fetch categories to build name -> id map for AI categorization
  const categories = await fastify.db.primary.category.findMany({
    select: { id: true, name: true },
  })

  const categoriesMap = new Map<string, string>(
    categories.map((c) => [c.name.toLowerCase().trim(), c.id]),
  )

  // 2. Register routes
  registerManualCaptureRoutes(fastify, categoriesMap)
}

export const capturePlugin = fp(captureModule, {
  name: 'module-capture',
  dependencies: ['04-database', '05-redis', '07-auth'],
})
