import { z } from 'zod'

// ──────────────────────────────────────────────────────────────────
// Request Schemas (Zod for domain validation)
// ──────────────────────────────────────────────────────────────────

export const registerTokenBodySchema = z.object({
  token: z.string().min(1, 'Token must not be empty').max(512),
  platform: z.enum(['ANDROID', 'IOS'], {
    errorMap: () => ({ message: "Platform must be either 'ANDROID' or 'IOS'" }),
  }),
})

export type RegisterTokenBody = z.infer<typeof registerTokenBodySchema>

export const unregisterTokenBodySchema = z.object({
  token: z.string().min(1, 'Token must not be empty').max(512),
})

export type UnregisterTokenBody = z.infer<typeof unregisterTokenBodySchema>

export const updatePreferencesBodySchema = z.object({
  budgetAlerts: z.boolean().optional(),
  paymentFailures: z.boolean().optional(),
  subscriptionExpiring: z.boolean().optional(),
  weeklyReports: z.boolean().optional(),
  monthlyReports: z.boolean().optional(),
}).refine((data) => {
  return Object.keys(data).length > 0
}, {
  message: 'At least one preference setting must be provided for update',
})

export type UpdatePreferencesBody = z.infer<typeof updatePreferencesBodySchema>

// ──────────────────────────────────────────────────────────────────
// JSON Schemas (for Fastify compiled serialiser)
// ──────────────────────────────────────────────────────────────────

export const registerTokenJsonSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['token', 'platform'],
    properties: {
      token: { type: 'string', minLength: 1, maxLength: 512 },
      platform: { type: 'string', enum: ['ANDROID', 'IOS'] },
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
          required: ['id', 'userId', 'token', 'platform'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
            token: { type: 'string' },
            platform: { type: 'string' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const unregisterTokenJsonSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['token'],
    properties: {
      token: { type: 'string', minLength: 1, maxLength: 512 },
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

export const getPreferencesJsonSchema = {
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
          required: [
            'userId',
            'budgetAlerts',
            'paymentFailures',
            'subscriptionExpiring',
            'weeklyReports',
            'monthlyReports',
          ],
          properties: {
            userId: { type: 'string', format: 'uuid' },
            budgetAlerts: { type: 'boolean' },
            paymentFailures: { type: 'boolean' },
            subscriptionExpiring: { type: 'boolean' },
            weeklyReports: { type: 'boolean' },
            monthlyReports: { type: 'boolean' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const updatePreferencesJsonSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      budgetAlerts: { type: 'boolean' },
      paymentFailures: { type: 'boolean' },
      subscriptionExpiring: { type: 'boolean' },
      weeklyReports: { type: 'boolean' },
      monthlyReports: { type: 'boolean' },
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
          required: [
            'userId',
            'budgetAlerts',
            'paymentFailures',
            'subscriptionExpiring',
            'weeklyReports',
            'monthlyReports',
          ],
          properties: {
            userId: { type: 'string', format: 'uuid' },
            budgetAlerts: { type: 'boolean' },
            paymentFailures: { type: 'boolean' },
            subscriptionExpiring: { type: 'boolean' },
            weeklyReports: { type: 'boolean' },
            monthlyReports: { type: 'boolean' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const
