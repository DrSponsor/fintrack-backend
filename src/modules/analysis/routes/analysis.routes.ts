import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../../core/middleware/authenticate'
import { GetWeeklyReportUseCase } from '../use-cases/get-weekly-report.use-case'
import { GetMonthlyReportUseCase } from '../use-cases/get-monthly-report.use-case'
import { PrismaAnalysisRepository } from '../repositories/analysis.repo'
import { parseISOWeek, parseISOMonth } from '../utils/date-parse'
import {
  getWeeklyReportQuerySchema,
  getWeeklyReportJsonSchema,
  getMonthlyReportQuerySchema,
  getMonthlyReportJsonSchema,
} from '../schemas/analysis.schemas'
import { successEnvelope } from '../../../core/http/envelope'

export function registerAnalysisRoutes(fastify: FastifyInstance<any, any, any, any, any>): void {
  const analysisRepo = new PrismaAnalysisRepository(fastify.db.primary, fastify.db.read)

  const getWeeklyReportUseCase = new GetWeeklyReportUseCase({
    analysisRepo,
    cache: fastify.cache,
    weeklyQueue: fastify.queues.analysisWeekly,
  })

  const getMonthlyReportUseCase = new GetMonthlyReportUseCase({
    analysisRepo,
    cache: fastify.cache,
    monthlyQueue: fastify.queues.analysisMonthly,
  })

  // ── GET /v1/analysis/weekly ─────────────────────────────────────
  fastify.get('/v1/analysis/weekly', {
    schema: getWeeklyReportJsonSchema,
    preHandler: [authenticate],
  }, async (request, reply) => {
    const query = getWeeklyReportQuerySchema.parse(request.query)
    const weekStart = parseISOWeek(query.week)

    const result = await getWeeklyReportUseCase.execute(request.user!.sub, weekStart)

    if (result.type === 'FOUND') {
      return reply.code(200).send(successEnvelope(result.report, request.requestId))
    }

    return reply.code(202).send(
      successEnvelope(
        {
          status: 'PENDING',
          jobId: result.jobId,
          message: 'Report recomputation has been queued.',
        },
        request.requestId,
      ),
    )
  })

  // ── GET /v1/analysis/monthly ────────────────────────────────────
  fastify.get('/v1/analysis/monthly', {
    schema: getMonthlyReportJsonSchema,
    preHandler: [authenticate],
  }, async (request, reply) => {
    const query = getMonthlyReportQuerySchema.parse(request.query)
    const monthStart = parseISOMonth(query.month)

    const result = await getMonthlyReportUseCase.execute(request.user!.sub, monthStart)

    if (result.type === 'FOUND') {
      return reply.code(200).send(successEnvelope(result.report, request.requestId))
    }

    return reply.code(202).send(
      successEnvelope(
        {
          status: 'PENDING',
          jobId: result.jobId,
          message: 'Report recomputation has been queued.',
        },
        request.requestId,
      ),
    )
  })
}
