import { z } from 'zod'

// ──────────────────────────────────────────────────────────────────
// Request Schemas (Zod)
// ──────────────────────────────────────────────────────────────────

export const createCheckoutBodySchema = z.object({
  planId: z.enum(['pro_monthly', 'pro_annual']),
  callbackUrl: z.string().url('Invalid callback URL'),
}).strict()

export type CreateCheckoutBody = z.infer<typeof createCheckoutBodySchema>

// ──────────────────────────────────────────────────────────────────
// JSON Schemas (Fastify compiled serialiser)
// ──────────────────────────────────────────────────────────────────

export const createCheckoutJsonSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['planId', 'callbackUrl'],
    properties: {
      planId: { type: 'string', enum: ['pro_monthly', 'pro_annual'] },
      callbackUrl: { type: 'string', format: 'uri' },
    },
  },
  response: {
    201: {
      type: 'object',
      additionalProperties: false,
      required: ['success', 'data', 'requestId'],
      properties: {
        success: { type: 'boolean', const: true },
        data: {
          type: 'object',
          additionalProperties: false,
          required: ['checkoutUrl'],
          properties: {
            checkoutUrl: { type: 'string' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const cancelSubscriptionJsonSchema = {
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

export const subscriptionStatusJsonSchema = {
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
          required: ['status', 'currentPeriodEnd'],
          properties: {
            status: { type: 'string', enum: ['ACTIVE', 'GRACE_PERIOD', 'CANCELLED', 'EXPIRED', 'NONE'] },
            currentPeriodEnd: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const
