import { z } from 'zod'

// ──────────────────────────────────────────────────────────────────
// Request Schemas
// ──────────────────────────────────────────────────────────────────

export const createAccountBodySchema = z.object({
  bankName: z.string().min(1, 'Bank name is required').max(100).trim(),
  accountLast4: z
    .string()
    .regex(/^[0-9]{4}$/, 'Must be exactly 4 digits'),
  accountType: z.enum(['CURRENT', 'SAVINGS', 'WALLET']),
  captureMethod: z.enum(['EMAIL', 'MANUAL', 'SMS', 'MONO']),
}).strict()

export type CreateAccountBody = z.infer<typeof createAccountBodySchema>

export const updateAccountBodySchema = z.object({
  bankName: z.string().min(1).max(100).trim().optional(),
  accountType: z.enum(['CURRENT', 'SAVINGS', 'WALLET']).optional(),
}).strict()

export type UpdateAccountBody = z.infer<typeof updateAccountBodySchema>

// ──────────────────────────────────────────────────────────────────
// JSON Schemas (Fastify compiled serialiser)
// ──────────────────────────────────────────────────────────────────

const accountObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'bankName', 'accountLast4', 'accountType', 'captureMethod', 'gmailConnected', 'balanceKobo'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    bankName: { type: 'string' },
    accountLast4: { type: 'string' },
    accountType: { type: 'string', enum: ['CURRENT', 'SAVINGS', 'WALLET'] },
    captureMethod: { type: 'string', enum: ['EMAIL', 'MANUAL', 'SMS', 'MONO'] },
    gmailConnected: { type: 'boolean' },
    balanceKobo: { type: 'string' },
    lastTransactionDate: { type: 'string', format: 'date-time', nullable: true },
  },
} as const

export const createAccountJsonSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['bankName', 'accountLast4', 'accountType', 'captureMethod'],
    properties: {
      bankName: { type: 'string', minLength: 1, maxLength: 100 },
      accountLast4: { type: 'string', pattern: '^[0-9]{4}$' },
      accountType: { type: 'string', enum: ['CURRENT', 'SAVINGS', 'WALLET'] },
      captureMethod: { type: 'string', enum: ['EMAIL', 'MANUAL', 'SMS', 'MONO'] },
    },
  },
  response: { 201: { type: 'object', additionalProperties: false, required: ['success', 'data', 'requestId'], properties: { success: { type: 'boolean', const: true }, data: accountObject, requestId: { type: 'string' } } } },
} as const

export const listAccountsJsonSchema = {
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      required: ['success', 'data', 'requestId'],
      properties: {
        success: { type: 'boolean', const: true },
        data: { type: 'array', items: accountObject },
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const getAccountJsonSchema = {
  response: { 200: { type: 'object', additionalProperties: false, required: ['success', 'data', 'requestId'], properties: { success: { type: 'boolean', const: true }, data: accountObject, requestId: { type: 'string' } } } },
} as const

export const deleteAccountJsonSchema = {
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
          properties: { message: { type: 'string' } },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const
