import { z } from 'zod'

// ──────────────────────────────────────────────────────────────────
// Request Schemas
// ──────────────────────────────────────────────────────────────────

export const updateProfileBodySchema = z.object({
  phone: z
    .string()
    .regex(/^\+234[0-9]{10}$/, 'Phone must be in Nigerian international format: +234XXXXXXXXXX')
    .optional(),
}).strict()

export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>

// ──────────────────────────────────────────────────────────────────
// JSON Schemas (Fastify compiled serialiser)
// ──────────────────────────────────────────────────────────────────

export const profileJsonSchema = {
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
          required: ['id', 'email', 'tier', 'createdAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string', nullable: true },
            tier: { type: 'string', enum: ['FREE', 'PRO'] },
            accountCount: { type: 'number' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const updateProfileJsonSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    properties: {
      phone: { type: 'string' },
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
          required: ['id', 'email', 'tier', 'createdAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
            phone: { type: 'string', nullable: true },
            tier: { type: 'string', enum: ['FREE', 'PRO'] },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const deleteDataJsonSchema = {
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
          required: ['message', 'scheduledDeletionAt'],
          properties: {
            message: { type: 'string' },
            scheduledDeletionAt: { type: 'string', format: 'date-time' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const
