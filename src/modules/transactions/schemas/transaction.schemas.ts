import { z } from 'zod'

// ──────────────────────────────────────────────────────────────────
// Request Schemas (Zod)
// ──────────────────────────────────────────────────────────────────

export const listTransactionsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .preprocess((val) => (typeof val === 'string' && val.trim() !== '' ? Number(val) : val), z.number().int().min(1).max(100))
    .default(20),
  accountId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  type: z.enum(['DEBIT', 'CREDIT']).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
}).strict()

export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>

export const correctCategoryBodySchema = z.object({
  categoryId: z.string().uuid('Invalid category ID'),
}).strict()

export type CorrectCategoryBody = z.infer<typeof correctCategoryBodySchema>

// ──────────────────────────────────────────────────────────────────
// JSON Schemas (Fastify compiled serialiser)
// ──────────────────────────────────────────────────────────────────

const transactionObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'accountId',
    'amountKobo',
    'type',
    'merchantName',
    'categoryId',
    'transactionDate',
    'source',
    'isVerified',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    accountId: { type: 'string', format: 'uuid' },
    amountKobo: { type: 'string' },
    type: { type: 'string', enum: ['DEBIT', 'CREDIT'] },
    merchantName: { type: 'string' },
    categoryId: { type: 'string', format: 'uuid' },
    transactionDate: { type: 'string', format: 'date-time' },
    source: { type: 'string', enum: ['EMAIL', 'MANUAL', 'SMS', 'MONO'] },
    isVerified: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const

export const listTransactionsJsonSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      accountId: { type: 'string', format: 'uuid' },
      categoryId: { type: 'string', format: 'uuid' },
      type: { type: 'string', enum: ['DEBIT', 'CREDIT'] },
      startDate: { type: 'string', format: 'date-time' },
      endDate: { type: 'string', format: 'date-time' },
    },
  },
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      required: ['success', 'data', 'meta', 'requestId'],
      properties: {
        success: { type: 'boolean', const: true },
        data: { type: 'array', items: transactionObject },
        meta: {
          type: 'object',
          additionalProperties: false,
          required: ['hasMore'],
          properties: {
            cursor: { type: 'string' },
            hasMore: { type: 'boolean' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const getTransactionJsonSchema = {
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      required: ['success', 'data', 'requestId'],
      properties: {
        success: { type: 'boolean', const: true },
        data: transactionObject,
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const correctCategoryJsonSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['categoryId'],
    properties: {
      categoryId: { type: 'string', format: 'uuid' },
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
