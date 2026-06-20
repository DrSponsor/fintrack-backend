import CircuitBreaker from 'opossum'
import { circuitBreakerStateGauge, externalApiCallsTotal, externalApiCallDurationSeconds } from '../../../core/observability/metrics'
import { dependencyUnavailable } from '../../../core/errors/factories'
import type { AppLogger } from '../../../core/logger'

export interface EmailMessagePayload {
  readonly to: string
  readonly subject: string
  readonly htmlBody: string
  readonly textBody?: string
}

export interface IEmailProvider {
  sendEmail(payload: EmailMessagePayload): Promise<void>
}

export class PostmarkProvider implements IEmailProvider {
  private readonly serverToken?: string | undefined
  private readonly fromAddress: string
  private readonly logger: AppLogger
  private readonly breaker: CircuitBreaker<[EmailMessagePayload], void>

  public constructor(
    logger: AppLogger,
    emailFrom: string,
    serverToken?: string | undefined
  ) {
    this.logger = logger
    this.fromAddress = emailFrom
    this.serverToken = serverToken

    this.breaker = new CircuitBreaker(
      this.sendEmailInternal.bind(this),
      {
        timeout: 10000, // 10 seconds
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    )

    this.breaker.on('open', () => circuitBreakerStateGauge.set({ name: 'postmark' }, 1))
    this.breaker.on('close', () => circuitBreakerStateGauge.set({ name: 'postmark' }, 0))
    this.breaker.on('halfOpen', () => circuitBreakerStateGauge.set({ name: 'postmark' }, 2))

    circuitBreakerStateGauge.set({ name: 'postmark' }, 0)
  }

  public async sendEmail(payload: EmailMessagePayload): Promise<void> {
    try {
      await this.breaker.fire(payload)
    } catch (err: unknown) {
      this.logger.error({ err, to: payload.to }, 'Postmark email delivery failed')
      throw dependencyUnavailable('Email service is temporarily unavailable')
    }
  }

  private async sendEmailInternal(payload: EmailMessagePayload): Promise<void> {
    // Fallback to mock logging if token is not configured (local dev / test)
    if (!this.serverToken || this.serverToken.length === 0 || this.serverToken === 'ts_postmark_server_token_fallback') {
      this.logger.info(
        { from: this.fromAddress, to: payload.to, subject: payload.subject, htmlBody: payload.htmlBody },
        '[MOCK POSTMARK] Email simulated successfully (server token not configured)'
      )
      return
    }

    const start = process.hrtime()
    try {
      const url = 'https://api.postmarkapp.com/email'

      const body = {
        From: this.fromAddress,
        To: payload.to,
        Subject: payload.subject,
        HtmlBody: payload.htmlBody,
        ...(payload.textBody ? { TextBody: payload.textBody } : {}),
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': this.serverToken,
        },
        body: JSON.stringify(body),
      })

      const duration = process.hrtime(start)
      const durationSeconds = duration[0] + duration[1] / 1e9
      externalApiCallDurationSeconds.observe({ service: 'postmark' }, durationSeconds)

      if (!response.ok) {
        const errorText = await response.text()
        this.logger.error(
          { status: response.status, errorText, to: payload.to },
          'Postmark API returned error response'
        )
        externalApiCallsTotal.inc({ service: 'postmark', status: response.status.toString() })
        throw new Error(`Postmark API failed with status ${response.status}: ${errorText}`)
      }

      externalApiCallsTotal.inc({ service: 'postmark', status: '200' })
    } catch (err: unknown) {
      const duration = process.hrtime(start)
      const durationSeconds = duration[0] + duration[1] / 1e9
      externalApiCallDurationSeconds.observe({ service: 'postmark' }, durationSeconds)
      externalApiCallsTotal.inc({ service: 'postmark', status: 'error' })
      throw err
    }
  }
}
