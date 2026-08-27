import { z } from 'zod'

/**
 * Kobo is stored as a Postgres BIGINT, so the hard ceiling is enormous. The cap
 * here is far lower on purpose: it is a typo guard, not a storage limit. Two
 * extra keystrokes on a phone keypad turn ₦5,000 into ₦500,000, and a balance
 * poisoned by a fat-fingered entry is worse than a rejected one.
 *
 * ₦9,999,999,999.99 sits well above any personal transaction while still
 * catching a digit slipped into the wrong column.
 */
const MAX_AMOUNT_KOBO = 999_999_999_999n

/**
 * A client clock can legitimately run a few minutes fast. Beyond that, a future
 * date is a mistake — usually a date picker left on the wrong month — and
 * letting it through silently reorders the ledger and corrupts every "this
 * month" total that reads it.
 */
const CLOCK_SKEW_MS = 5 * 60 * 1000

/** Ten years back. Anything older is a parsing accident, not a memory. */
const OLDEST_PLAUSIBLE_MS = 10 * 365 * 24 * 60 * 60 * 1000

export const manualCaptureBodySchema = z
  .object({
    accountId: z.string().uuid('Invalid account ID'),
    amountKobo: z
      .string()
      .regex(/^\d+$/, 'Amount must be a whole number of kobo')
      .refine((value) => BigInt(value) > 0n, 'Amount must be greater than zero')
      .refine((value) => BigInt(value) <= MAX_AMOUNT_KOBO, 'That amount looks too large — please check it'),
    type: z.enum(['DEBIT', 'CREDIT']),
    merchantName: z
      .string()
      .min(1, 'Who was this with?')
      .max(100)
      .trim()
      // A name of pure punctuation normalises to an empty fingerprint, which
      // would then match every other punctuation-only name in the shared
      // merchant map. Require something a fingerprint can actually be built on.
      .refine((value) => /[a-zA-Z0-9]/.test(value), 'Enter a name with at least one letter or number'),
    transactionDate: z
      .string()
      .datetime('Invalid transactionDate format')
      .refine(
        (value) => Date.parse(value) <= Date.now() + CLOCK_SKEW_MS,
        'That date is in the future',
      )
      .refine(
        (value) => Date.parse(value) >= Date.now() - OLDEST_PLAUSIBLE_MS,
        'That date is too far in the past',
      ),
    /**
     * The user's own choice at entry time, when they made one.
     *
     * Deliberately a statement about THIS payment and nothing more: it is not
     * fed back as a merchant rule. Choosing "Food" while typing in a transfer
     * to a person says what that transfer was for, not what every future
     * transfer to them will be for — the same reasoning that keeps
     * CorrectCategoryUseCase from backfilling a transfer correction.
     */
    categoryId: z.string().uuid('Invalid category ID').optional(),
    /**
     * Set only after the user has been shown a possible duplicate and said to
     * record it anyway. Never sent on a first attempt.
     */
    force: z.boolean().optional(),
  })
  .strict()

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
    // The bank's own id for this payment. Null on anything entered by hand,
    // and on banks whose alerts do not state one.
    providerRef: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
  },
} as const

/**
 * Fastify strips anything a response schema does not declare, so the outcome
 * discriminator has to be spelled out here or it never reaches the client.
 */
const captureResultObject = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'transaction'],
  properties: {
    outcome: { type: 'string', enum: ['recorded', 'already-recorded', 'duplicate-suspected'] },
    transaction: transactionObject,
    reason: { type: 'string' },
  },
} as const

const envelope = {
  type: 'object',
  additionalProperties: false,
  required: ['success', 'data', 'requestId'],
  properties: {
    success: { type: 'boolean', const: true },
    data: captureResultObject,
    requestId: { type: 'string' },
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
      categoryId: { type: 'string', format: 'uuid' },
      force: { type: 'boolean' },
    },
  },
  response: {
    // 201 only when a row was actually created. A suspected duplicate returns
    // 200: the request succeeded and the server is answering it, but nothing
    // was created, and saying "201 Created" about a write that did not happen
    // is a lie the client would have to work around.
    200: envelope,
    201: envelope,
  },
} as const
