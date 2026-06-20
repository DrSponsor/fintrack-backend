import { AppError } from './AppError'
import { ERROR_CODES } from './codes'

export function validationError(message: string, field?: string): AppError {
  return new AppError(ERROR_CODES.VALIDATION_FAILED, message, 400, field ? { field } : {})
}

export function unauthenticated(message = 'Authentication required'): AppError {
  return new AppError(ERROR_CODES.UNAUTHENTICATED, message, 401)
}

export function tokenExpired(message = 'Access token has expired'): AppError {
  return new AppError(ERROR_CODES.TOKEN_EXPIRED, message, 401)
}

export function tokenRevoked(message = 'Token has been revoked'): AppError {
  return new AppError(ERROR_CODES.TOKEN_REVOKED, message, 401)
}

export function subscriptionRequired(message = 'Pro subscription required'): AppError {
  return new AppError(ERROR_CODES.SUBSCRIPTION_REQUIRED, message, 402)
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

export function duplicateEmail(message = 'An account with this email already exists'): AppError {
  return new AppError(ERROR_CODES.DUPLICATE_EMAIL, message, 409, { field: 'email' })
}

export function invalidCredentials(message = 'Invalid email or password'): AppError {
  return new AppError(ERROR_CODES.INVALID_CREDENTIALS, message, 401)
}

export function rateLimited(message = 'Too many requests'): AppError {
  return new AppError(ERROR_CODES.RATE_LIMITED, message, 429)
}

export function deletionPending(message = 'Account is scheduled for deletion'): AppError {
  return new AppError(ERROR_CODES.DELETION_PENDING, message, 409)
}

export function dependencyUnavailable(message = 'Dependency unavailable'): AppError {
  return new AppError(ERROR_CODES.DEPENDENCY_UNAVAILABLE, message, 503, { expose: true })
}
