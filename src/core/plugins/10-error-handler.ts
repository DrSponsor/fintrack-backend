import fp from 'fastify-plugin'
import type { FastifyPluginCallback } from 'fastify'
import { ZodError } from 'zod'
import { AppError } from '../errors/AppError'
import { ERROR_CODES } from '../errors/codes'
import type { ErrorEnvelope } from '../http/envelope'

function isFastifyValidationError(error: Error): boolean {
  return 'validation' in error && Array.isArray((error as { readonly validation?: unknown }).validation)
}

const plugin: FastifyPluginCallback = (fastify, _options, done) => {
  fastify.setErrorHandler<Error>((error, request, reply) => {
    if (error instanceof AppError) {
      const envelope: ErrorEnvelope = {
        success: false,
        error: {
          code: error.code,
          message: error.expose ? error.message : 'Internal server error',
          ...(error.field ? { field: error.field } : {}),
        },
        requestId: request.requestId,
      }
      reply.code(error.statusCode).send(envelope)
      return
    }

    if (error instanceof ZodError) {
      const firstIssue = error.issues[0]
      const envelope: ErrorEnvelope = {
        success: false,
        error: {
          code: ERROR_CODES.VALIDATION_FAILED,
          message: firstIssue?.message ?? 'Validation failed',
          ...(firstIssue?.path[0] ? { field: String(firstIssue.path[0]) } : {}),
        },
        requestId: request.requestId,
      }
      reply.code(400).send(envelope)
      return
    }

    if (isFastifyValidationError(error)) {
      const envelope: ErrorEnvelope = {
        success: false,
        error: {
          code: ERROR_CODES.VALIDATION_FAILED,
          message: 'Validation failed',
        },
        requestId: request.requestId,
      }
      reply.code(400).send(envelope)
      return
    }

    request.log.error({ err: error }, 'unhandled request error')
    const envelope: ErrorEnvelope = {
      success: false,
      error: {
        code: ERROR_CODES.INTERNAL,
        message: 'Internal server error',
      },
      requestId: request.requestId,
    }
    reply.code(500).send(envelope)
  })
  done()
}

export const errorHandlerPlugin = fp(plugin, {
  name: '10-error-handler',
})
