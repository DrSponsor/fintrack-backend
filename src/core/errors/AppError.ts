import type { ErrorCode } from './codes'

export type AppErrorOptions = {
  readonly field?: string
  readonly cause?: unknown
  readonly expose?: boolean
}

export class AppError extends Error {
  public readonly code: ErrorCode
  public readonly statusCode: number
  public readonly field?: string
  public readonly expose: boolean

  public constructor(code: ErrorCode, message: string, statusCode: number, options: AppErrorOptions = {}) {
    if (options.cause === undefined) {
      super(message)
    } else {
      super(message, { cause: options.cause })
    }
    this.name = 'AppError'
    this.code = code
    this.statusCode = statusCode
    this.expose = options.expose ?? statusCode < 500
    if (options.field !== undefined) {
      this.field = options.field
    }
  }
}
