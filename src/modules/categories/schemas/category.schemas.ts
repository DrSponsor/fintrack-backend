const categoryObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'icon'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    icon: { type: 'string' },
  },
} as const

export const listCategoriesJsonSchema = {
  response: {
    200: {
      type: 'object',
      additionalProperties: false,
      required: ['success', 'data', 'requestId'],
      properties: {
        success: { type: 'boolean', const: true },
        data: { type: 'array', items: categoryObject },
        requestId: { type: 'string' },
      },
    },
  },
} as const
