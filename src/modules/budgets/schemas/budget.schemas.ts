import { z } from 'zod'

// ──────────────────────────────────────────────────────────────────
// Request Schemas (Zod)
// ──────────────────────────────────────────────────────────────────

export const createBudgetBodySchema = z.object({
  categoryId: z.string().uuid('Invalid category ID'),
  limitKobo: z.string().regex(/^\d+$/, 'limitKobo must be a positive numeric string representing kobo'),
  periodType: z.enum(['WEEKLY', 'MONTHLY']),
}).strict()

export type CreateBudgetBody = z.infer<typeof createBudgetBodySchema>

// ──────────────────────────────────────────────────────────────────
// JSON Schemas (Fastify compiled serialiser)
// ──────────────────────────────────────────────────────────────────

const budgetObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'userId', 'categoryId', 'limitKobo', 'periodType', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    categoryId: { type: 'string', format: 'uuid' },
    limitKobo: { type: 'string' },
    periodType: { type: 'string', enum: ['WEEKLY', 'MONTHLY'] },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const

export const createBudgetJsonSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['categoryId', 'limitKobo', 'periodType'],
    properties: {
      categoryId: { type: 'string', format: 'uuid' },
      limitKobo: { type: 'string', pattern: '^\\d+$' },
      periodType: { type: 'string', enum: ['WEEKLY', 'MONTHLY'] },
    },
  },
  response: {
    201: {
      type: 'object',
      additionalProperties: false,
      required: ['success', 'data', 'requestId'],
      properties: {
        success: { type: 'boolean', const: true },
        data: budgetObject,
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const listBudgetsJsonSchema = {
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      required: ['success', 'data', 'requestId'],
      properties: {
        success: { type: 'boolean', const: true },
        data: { type: 'array', items: budgetObject },
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const deleteBudgetJsonSchema = {
  params: {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      required: ['success', 'data', 'requestId'],
      properties: {
        success: { type: 'boolean', const: true },
        data: {
          type: 'object',
          additionalProperties: false,
          required: ['message'],
          properties: {
            message: { type: 'string' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const
