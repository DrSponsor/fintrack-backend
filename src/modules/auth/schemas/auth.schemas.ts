import { z } from 'zod'

// ──────────────────────────────────────────────────────────────────
// Request Schemas (Zod for domain validation)
// ──────────────────────────────────────────────────────────────────

export const registerBodySchema = z.object({
  email: z.string().email('Invalid email address').max(255).transform((v) => v.toLowerCase().trim()),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one digit')
    .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
})

export type RegisterBody = z.infer<typeof registerBodySchema>

export const loginBodySchema = z.object({
  email: z.string().email().max(255).transform((v) => v.toLowerCase().trim()),
  password: z.string().min(1, 'Password is required').max(128),
})

export type LoginBody = z.infer<typeof loginBodySchema>

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
})

export type RefreshBody = z.infer<typeof refreshBodySchema>

// ──────────────────────────────────────────────────────────────────
// JSON Schemas (for Fastify compiled serialiser)
// ──────────────────────────────────────────────────────────────────

export const registerJsonSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 255 },
      password: { type: 'string', minLength: 8, maxLength: 128 },
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
          required: ['userId', 'accessToken', 'expiresIn'],
          properties: {
            userId: { type: 'string', format: 'uuid' },
            accessToken: { type: 'string' },
            expiresIn: { type: 'number' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const loginJsonSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 255 },
      password: { type: 'string', minLength: 1, maxLength: 128 },
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
          required: ['accessToken', 'expiresIn'],
          properties: {
            accessToken: { type: 'string' },
            expiresIn: { type: 'number' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const refreshJsonSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['refreshToken'],
    properties: {
      refreshToken: { type: 'string', minLength: 1 },
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
          required: ['accessToken', 'refreshToken', 'expiresIn'],
          properties: {
            accessToken: { type: 'string' },
            refreshToken: { type: 'string' },
            expiresIn: { type: 'number' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const logoutJsonSchema = {
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
