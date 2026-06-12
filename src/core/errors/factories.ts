import { AppError } from './AppError'
import { ERROR_CODES } from './codes'

export function validationError(message: string, field?: string): AppError {
  return new AppError(ERROR_CODES.VALIDATION_FAILED, message, 400, field ? { field } : {})
}

export function unauthenticated(message = 'Authentication required'): AppError {
  return new AppError(ERROR_CODES.UNAUTHENTICATED, message, 401)
}

export function forbidden(message = 'Insufficient permissions'): AppError {
  return new AppError(ERROR_CODES.FORBIDDEN, message, 403)
}

export function notFound(message = 'Resource not found'): AppError {
  return new AppError(ERROR_CODES.NOT_FOUND, message, 404)
}

export function conflict(message = 'Conflict'): AppError {
  return new AppError(ERROR_CODES.CONFLICT, message, 409)
}

export function dependencyUnavailable(message = 'Dependency unavailable'): AppError {
  return new AppError(ERROR_CODES.DEPENDENCY_UNAVAILABLE, message, 503, { expose: true })
}
