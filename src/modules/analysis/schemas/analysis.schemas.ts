import { z } from 'zod'

// ──────────────────────────────────────────────────────────────────
// Request Schemas (Zod)
// ──────────────────────────────────────────────────────────────────

export const getWeeklyReportQuerySchema = z.object({
  week: z.string().regex(/^\d{4}-W\d{2}$/, 'week must be in YYYY-Www format (e.g., 2026-W20)'),
}).strict()

export type GetWeeklyReportQuery = z.infer<typeof getWeeklyReportQuerySchema>

export const getMonthlyReportQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/, 'month must be in YYYY-MM format (e.g., 2026-06)'),
}).strict()

export type GetMonthlyReportQuery = z.infer<typeof getMonthlyReportQuerySchema>

// ──────────────────────────────────────────────────────────────────
// JSON Schemas (Fastify compiled serialiser)
// ──────────────────────────────────────────────────────────────────

const reportDataSchema = {
  type: 'object',
  properties: {
    categoryTotals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          categoryId: { type: 'string', format: 'uuid' },
          categoryName: { type: 'string' },
          spentKobo: { type: 'string' },
          percentage: { type: 'string' },
        },
        required: ['categoryId', 'categoryName', 'spentKobo', 'percentage'],
      },
    },
    wowChange: {
      type: 'object',
      properties: {
        percentageChange: { type: 'string' },
        previousSpentKobo: { type: 'string' },
      },
      required: ['percentageChange', 'previousSpentKobo'],
    },
    momChange: {
      type: 'object',
      properties: {
        percentageChange: { type: 'string' },
        previousSpentKobo: { type: 'string' },
      },
      required: ['percentageChange', 'previousSpentKobo'],
    },
    incomeVsSpend: {
      type: 'object',
      properties: {
        totalSpentKobo: { type: 'string' },
        totalIncomeKobo: { type: 'string' },
        savingsRate: { type: 'string' },
      },
      required: ['totalSpentKobo', 'totalIncomeKobo', 'savingsRate'],
    },
    topMerchants: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          merchantName: { type: 'string' },
          spentKobo: { type: 'string' },
        },
        required: ['merchantName', 'spentKobo'],
      },
    },
    spendByDay: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          spentKobo: { type: 'string' },
        },
        required: ['date', 'spentKobo'],
      },
    },
    anomalies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          spentKobo: { type: 'string' },
          thresholdKobo: { type: 'string' },
        },
        required: ['date', 'spentKobo', 'thresholdKobo'],
      },
    },
    budgets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          budgetId: { type: 'string', format: 'uuid' },
          categoryId: { type: 'string', format: 'uuid' },
          limitKobo: { type: 'string' },
          spentKobo: { type: 'string' },
          remainingKobo: { type: 'string' },
          projectedSpentKobo: { type: 'string' },
          status: { type: 'string', enum: ['GREEN', 'YELLOW', 'RED'] },
        },
        required: ['budgetId', 'categoryId', 'limitKobo', 'spentKobo', 'remainingKobo', 'projectedSpentKobo', 'status'],
      },
    },
    recurring: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          merchantName: { type: 'string' },
          amountKobo: { type: 'string' },
          frequency: { type: 'string', enum: ['WEEKLY', 'MONTHLY'] },
          nextExpectedDate: { type: 'string' },
        },
        required: ['merchantName', 'amountKobo', 'frequency', 'nextExpectedDate'],
      },
    },
    forecast: {
      type: 'object',
      properties: {
        projectedSpentKobo: { type: 'string' },
        projectedIncomeKobo: { type: 'string' },
        projectedNetKobo: { type: 'string' },
        confidenceRating: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
      },
      required: ['projectedSpentKobo', 'projectedIncomeKobo', 'projectedNetKobo', 'confidenceRating'],
    },
    narrative: { type: 'string' },
  },
}

const reportObjectSchema = {
  type: 'object',
  required: ['id', 'userId', 'periodType', 'periodStart', 'periodEnd', 'isStale', 'schemaVersion', 'data', 'generatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    periodType: { type: 'string', enum: ['WEEKLY', 'MONTHLY'] },
    periodStart: { type: 'string', format: 'date-time' },
    periodEnd: { type: 'string', format: 'date-time' },
    isStale: { type: 'boolean' },
    schemaVersion: { type: 'integer' },
    data: reportDataSchema,
    generatedAt: { type: 'string', format: 'date-time' },
  },
}

const pendingJobSchema = {
  type: 'object',
  required: ['status', 'jobId', 'message'],
  properties: {
    status: { type: 'string', const: 'PENDING' },
    jobId: { type: 'string' },
    message: { type: 'string' },
  },
}

export const getWeeklyReportJsonSchema = {
  querystring: {
    type: 'object',
    required: ['week'],
    properties: {
      week: { type: 'string', pattern: '^\\d{4}-W\\d{2}$' },
    },
  },
  response: {
    200: {
      type: 'object',
      required: ['success', 'data', 'requestId'],
      properties: {
        success: { type: 'boolean', const: true },
        data: reportObjectSchema,
        requestId: { type: 'string' },
      },
    },
    202: {
      type: 'object',
      required: ['success', 'data', 'requestId'],
      properties: {
        success: { type: 'boolean', const: true },
        data: pendingJobSchema,
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const getMonthlyReportJsonSchema = {
  querystring: {
    type: 'object',
    required: ['month'],
    properties: {
      month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
    },
  },
  response: {
    200: {
      type: 'object',
      required: ['success', 'data', 'requestId'],
      properties: {
        success: { type: 'boolean', const: true },
        data: reportObjectSchema,
        requestId: { type: 'string' },
      },
    },
    202: {
      type: 'object',
      required: ['success', 'data', 'requestId'],
      properties: {
        success: { type: 'boolean', const: true },
        data: pendingJobSchema,
        requestId: { type: 'string' },
      },
    },
  },
} as const
