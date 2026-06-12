import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { createLoggerOptions } from '../src/core/logger'
import { piiRedactionPaths } from '../src/core/logger/redact'
import { createTestConfig } from './helpers/fakes'

describe('logger redaction', () => {
  it('includes the sensitive fields required by the architecture', () => {
    expect(piiRedactionPaths).toContain('req.headers.authorization')
    expect(piiRedactionPaths).toContain('gmailTokenEnc')
    expect(piiRedactionPaths).toContain('rawSnippetEnc')
    expect(piiRedactionPaths).toContain('accountNumber')
  })

  it('redacts sensitive fields in structured logs', () => {
    const lines: string[] = []
    const stream = {
      write: (line: string): void => {
        lines.push(line)
      },
    }

    const logger = pino(createLoggerOptions(createTestConfig({ LOG_LEVEL: 'info' })), stream)
    logger.info({
      req: { headers: { authorization: 'Bearer secret' } },
      gmailTokenEnc: 'encrypted-token',
      accountNumber: '0123456789',
    }, 'redaction check')

    const output = lines.join('')
    expect(output).toContain('[REDACTED]')
    expect(output).not.toContain('Bearer secret')
    expect(output).not.toContain('encrypted-token')
    expect(output).not.toContain('0123456789')
  })
})
