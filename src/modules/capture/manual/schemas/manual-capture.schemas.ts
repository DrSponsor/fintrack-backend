import { z } from 'zod'

export const manualCaptureBodySchema = z.object({
  accountId: z.string().uuid('Invalid account ID'),
  amountKobo: z.string().regex(/^\d+$/, 'amountKobo must be a positive integer string representing kobo'),
  type: z.enum(['DEBIT', 'CREDIT']),
  merchantName: z.string().min(1, 'Merchant name is required').max(100).trim(),
  transactionDate: z.string().datetime('Invalid transactionDate format'),
}).strict()

export type ManualCaptureBody = z.infer<typeof manualCaptureBodySchema>

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

export const manualCaptureJsonSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['accountId', 'amountKobo', 'type', 'merchantName', 'transactionDate'],
    properties: {
      accountId: { type: 'string', format: 'uuid' },
      amountKobo: { type: 'string', pattern: '^\\d+$' },
      type: { type: 'string', enum: ['DEBIT', 'CREDIT'] },
      merchantName: { type: 'string', minLength: 1, maxLength: 100 },
      transactionDate: { type: 'string', format: 'date-time' },
    },
  },
  response: {
    201: {
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
