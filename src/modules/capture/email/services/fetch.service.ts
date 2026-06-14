import type { AppLogger } from '../../../../core/logger'
import { AppError } from '../../../../core/errors/AppError'
import { ERROR_CODES } from '../../../../core/errors/codes'

export class GmailQuotaExhaustedError extends Error {
  public constructor(message = 'Gmail API quota exhausted (429)') {
    super(message)
    this.name = 'GmailQuotaExhaustedError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export type GmailEmailDetails = {
  readonly id: string
  readonly subject: string
  readonly from: string
  readonly senderEmail: string
  readonly senderDomain: string
  readonly date: Date
  readonly bodyHtml: string
  readonly bodyText: string
}

export class FetchService {
  private readonly logger: AppLogger

  public constructor(logger: AppLogger) {
    this.logger = logger
  }

  public async fetchEmailWithBackoff(messageId: string, accessToken: string): Promise<GmailEmailDetails> {
    const maxAttempts = 3
    const backoffDelays = [1000, 2000, 4000] as const

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          },
        )

        if (response.status === 429) {
          if (attempt < maxAttempts) {
            const delay = backoffDelays[attempt] ?? 1000
            this.logger.warn(
              { messageId, attempt: attempt + 1, delay },
              'Gmail API rate limited (429). Retrying after backoff.',
            )
            await new Promise((resolve) => setTimeout(resolve, delay))
            continue
          } else {
            this.logger.error(
              { messageId },
              'Gmail API rate limit exhausted after max backoff attempts. Throwing GmailQuotaExhaustedError.',
            )
            throw new GmailQuotaExhaustedError()
          }
        }

        if (!response.ok) {
          const errorText = await response.text()
          this.logger.error(
            { messageId, status: response.status, errorText },
            'Failed to fetch message from Gmail API',
          )
          throw new AppError(
            ERROR_CODES.DEPENDENCY_UNAVAILABLE,
            `Failed to fetch email message: ${response.statusText}`,
            503,
          )
        }

        const message = await response.json() as {
          readonly id: string
          readonly internalDate?: string
          readonly payload?: {
            readonly mimeType?: string
            readonly headers?: readonly { readonly name: string; readonly value: string }[]
            readonly body?: { readonly data?: string }
            readonly parts?: readonly any[]
          }
        }

        const headers = message.payload?.headers ?? []
        const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value ?? ''
        const from = headers.find((h) => h.name.toLowerCase() === 'from')?.value ?? ''
        
        // Parse email address and domain from the From header
        const emailMatch = from.match(/<([^>]+)>/) ?? from.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)
        const senderEmail = emailMatch ? (emailMatch[1] ?? '').trim() : from.trim()
        const senderDomain = senderEmail.split('@')[1]?.toLowerCase().trim() ?? ''

        const date = message.internalDate ? new Date(Number(message.internalDate)) : new Date()

        // Extract HTML and plain text bodies
        const bodies = { html: '', text: '' }
        const extractBodyParts = (part: any) => {
          if (part.mimeType === 'text/html' && part.body?.data) {
            bodies.html += Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
          } else if (part.mimeType === 'text/plain' && part.body?.data) {
            bodies.text += Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
          }

          if (part.parts) {
            for (const subPart of part.parts) {
              extractBodyParts(subPart)
            }
          }
        }

        if (message.payload) {
          extractBodyParts(message.payload)
        }

        return {
          id: message.id,
          subject,
          from,
          senderEmail,
          senderDomain,
          date,
          bodyHtml: bodies.html,
          bodyText: bodies.text,
        }
      } catch (err) {
        if (err instanceof GmailQuotaExhaustedError) {
          throw err
        }
        if (err instanceof AppError) {
          throw err
        }
        this.logger.error({ messageId, err }, 'Unexpected error in fetchEmailWithBackoff')
        throw new AppError(
          ERROR_CODES.INTERNAL,
          err instanceof Error ? err.message : 'Unknown error during Gmail fetch',
          500,
        )
      }
    }

    throw new AppError(ERROR_CODES.INTERNAL, 'Unreachable code in fetchEmailWithBackoff', 500)
  }
}
