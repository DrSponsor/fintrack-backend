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

/**
 * How far a correction reaches.
 *
 * A counterparty does not always determine a category. For a business it
 * usually does — Spotify is subscriptions every time — so correcting one
 * Spotify charge should fix the earlier ones and every future one.
 *
 * For a PERSON it does not. Money sent to the same individual can be food
 * today and a thrift contribution tomorrow: the counterparty is constant while
 * the purpose changes. Applying one correction to every transfer with that
 * person would be confidently wrong, and wrong retroactively.
 *
 *   'transaction' — this row only. Nothing remembered, nothing backfilled.
 *   'merchant'    — remember it for this user, and apply it to their earlier
 *                   and future transactions with the same counterparty.
 *
 * Omitted, the server chooses: 'transaction' when the row currently sits in
 * transfers (the counterparty is an individual), 'merchant' otherwise. The
 * cautious option is the default in the ambiguous case, because an unwanted
 * rewrite of history is far harder to notice than a correction that failed to
 * spread.
 */
export const correctCategoryBodySchema = z.object({
  categoryId: z.string().uuid('Invalid category ID'),
  scope: z.enum(['transaction', 'merchant']).optional(),
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
    // The bank's own id for this payment. Null on anything entered by hand,
    // and on banks whose alerts do not state one.
    providerRef: { type: 'string', nullable: true },
    transferGroupId: { type: 'string', nullable: true },
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
      scope: { type: 'string', enum: ['transaction', 'merchant'] },
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
          required: ['message', 'scope', 'backfilled'],
          properties: {
            message: { type: 'string' },
            /** The reach actually applied — which may be the server's default
             *  rather than what the client asked for. */
            scope: { type: 'string', enum: ['transaction', 'merchant'] },
            /** How many EARLIER transactions were changed. Zero for a
             *  single-row correction. Fastify strips undeclared fields from
             *  responses, so omitting these here would silently drop them. */
            backfilled: { type: 'integer' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const deleteTransactionJsonSchema = {
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

export const correctDateBodySchema = z
  .object({
    transactionDate: z.string().datetime('Invalid transactionDate format'),
  })
  .strict()

export const correctDateJsonSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['transactionDate'],
    properties: {
      transactionDate: { type: 'string', format: 'date-time' },
    },
  },
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

/**
 * The merchants a person has recorded before, for typeahead on manual entry.
 *
 * `categoryId` is nullable on purpose: it is the category this merchant
 * usually lands in, and a merchant whose uses are split evenly between two
 * categories has no usual answer. Null says "no guess" rather than offering a
 * coin toss as a prediction.
 */
export const listMerchantsJsonSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean', const: true },
        data: {
          type: 'array',
          items: {
            type: 'object',
            required: ['merchantName', 'uses', 'lastUsedAt'],
            properties: {
              merchantName: { type: 'string' },
              categoryId: { type: 'string', nullable: true },
              uses: { type: 'number' },
              lastUsedAt: { type: 'string' },
            },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const
