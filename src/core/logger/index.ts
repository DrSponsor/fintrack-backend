import pino from 'pino'
import type { AppConfig } from '../../config'
import { piiRedactionPaths } from './redact'

export type AppLogger = pino.Logger

export function createLoggerOptions(appConfig: AppConfig): pino.LoggerOptions {
  return {
    name: 'fintrack-backend',
    level: appConfig.logLevel,
    base: {
      service: 'fintrack-backend',
      env: appConfig.nodeEnv,
    },
    redact: {
      paths: [...piiRedactionPaths],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  }
}

export function createLogger(appConfig: AppConfig): AppLogger {
  return pino(createLoggerOptions(appConfig))
}
