export const initiateDeletionJsonSchema = {
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
          required: ['scheduledAt', 'message'],
          properties: {
            scheduledAt: { type: 'string', format: 'date-time' },
            message: { type: 'string' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const

export const cancelDeletionJsonSchema = {
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

export const initiateExportJsonSchema = {
  response: {
    202: {
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

export const emailAccessLogJsonSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      required: ['success', 'data', 'meta', 'requestId'],
      properties: {
        success: { type: 'boolean', const: true },
        data: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'messageId', 'senderDomain', 'subject', 'outcome', 'accessedAt'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              messageId: { type: 'string' },
              senderDomain: { type: 'string' },
              subject: { type: 'string' },
              outcome: {
                type: 'string',
                enum: [
                  'TRANSACTION_CREATED',
                  'DUPLICATE_SUPPRESSED',
                  'DISCARDED_SAFETY_FILTER',
                  'DISCARDED_NO_KEYWORDS',
                  'PARSE_FAILED',
                ],
              },
              accessedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
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

export const deletionStatusJsonSchema = {
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
          required: ['pending'],
          properties: {
            pending: { type: 'boolean' },
            scheduledAt: { type: 'string', format: 'date-time' },
          },
        },
        requestId: { type: 'string' },
      },
    },
  },
} as const
