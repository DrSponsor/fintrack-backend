import type { ErrorCode } from '../errors/codes'

export type SuccessEnvelope<TData, TMeta = Record<string, never>> = {
  readonly success: true
  readonly data: TData
  readonly meta?: TMeta
  readonly requestId: string
}

export type ErrorEnvelope = {
  readonly success: false
  readonly error: {
    readonly code: ErrorCode
    readonly message: string
    readonly field?: string
  }
  readonly requestId: string
}

export function successEnvelope<TData, TMeta = Record<string, never>>(
  data: TData,
  requestId: string,
  meta?: TMeta,
): SuccessEnvelope<TData, TMeta> {
  return meta === undefined
    ? { success: true, data, requestId }
    : { success: true, data, meta, requestId }
}
