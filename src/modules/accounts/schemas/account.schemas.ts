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
  required: ['id', 'bankName', 'accountLast4', 'accountType', 'captureMethod', 'gmailConnected', 'balanceKobo', 'adjustmentKobo', 'transactionCount'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    bankName: { type: 'string' },
    accountLast4: { type: 'string' },
    // The bank's own masked number, when the account was discovered from an
    // alert rather than typed. It is the better identifier of the two and for
    // a discovered account it may be the ONLY one: Access reveals three
    // digits, and padding those to a four-digit accountLast4 would invent one.
    // Without this field such an account renders as "···· " with nothing after
    // it, which is precisely the case discovery creates.
    accountMask: { type: 'string', nullable: true },
    // Who the bank addresses. Shown so a person can tell their own account
    // from one that arrived in a shared or forwarded inbox.
    holderName: { type: 'string', nullable: true },
    // How the app came to believe this account is theirs. Stated in words on
    // the client rather than implied by a tick, because "confirmed from a bank
    // alert" and "somebody typed it" are different claims and only one of them
    // is evidence.
    verificationSource: { type: 'string', enum: ['SELF_DECLARED', 'EMAIL_DISCOVERY'] },
    accountType: { type: 'string', enum: ['CURRENT', 'SAVINGS', 'WALLET'] },
    captureMethod: { type: 'string', enum: ['EMAIL', 'MANUAL', 'SMS', 'MONO'] },
    gmailConnected: { type: 'boolean' },
    balanceKobo: { type: 'string', nullable: true },
    adjustmentKobo: { type: 'string' },
    transactionCount: { type: 'integer' },
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
