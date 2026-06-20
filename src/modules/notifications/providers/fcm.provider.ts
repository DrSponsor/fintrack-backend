import CircuitBreaker from 'opossum'
import * as jose from 'jose'
import { circuitBreakerStateGauge, externalApiCallsTotal, externalApiCallDurationSeconds } from '../../../core/observability/metrics'
import { dependencyUnavailable } from '../../../core/errors/factories'
import type { AppLogger } from '../../../core/logger'

export interface PushMessagePayload {
  readonly token: string
  readonly title?: string | undefined
  readonly body?: string | undefined
  readonly data?: Record<string, string> | undefined
  readonly silent?: boolean | undefined
}

export interface IPushProvider {
  sendPush(payload: PushMessagePayload): Promise<void>
}

export class FcmProvider implements IPushProvider {
  private readonly projectId?: string | undefined
  private readonly clientEmail?: string | undefined
  private readonly privateKey?: string | undefined
  private readonly logger: AppLogger
  private readonly breaker: CircuitBreaker<[PushMessagePayload], void>

  // In-memory OAuth2 token caching
  private cachedAccessToken: string | null = null
  private tokenExpiryEpochMs: number = 0

  public constructor(
    logger: AppLogger,
    firebaseConfig: {
      readonly projectId?: string | undefined
      readonly clientEmail?: string | undefined
      readonly privateKey?: string | undefined
    }
  ) {
    this.logger = logger
    this.projectId = firebaseConfig.projectId
    this.clientEmail = firebaseConfig.clientEmail
    this.privateKey = firebaseConfig.privateKey

    this.breaker = new CircuitBreaker(
      this.sendPushInternal.bind(this),
      {
        timeout: 10000, // 10 seconds
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    )

    this.breaker.on('open', () => circuitBreakerStateGauge.set({ name: 'fcm' }, 1))
    this.breaker.on('close', () => circuitBreakerStateGauge.set({ name: 'fcm' }, 0))
    this.breaker.on('halfOpen', () => circuitBreakerStateGauge.set({ name: 'fcm' }, 2))

    circuitBreakerStateGauge.set({ name: 'fcm' }, 0)
  }

  public async sendPush(payload: PushMessagePayload): Promise<void> {
    try {
      await this.breaker.fire(payload)
    } catch (err: unknown) {
      this.logger.error({ err, token: payload.token }, 'FCM push notification delivery failed')
      throw dependencyUnavailable('Push notification service is temporarily unavailable')
    }
  }

  private async sendPushInternal(payload: PushMessagePayload): Promise<void> {
    // Fallback to mock logging if credentials are not configured (local dev / test)
    if (!this.projectId || !this.clientEmail || !this.privateKey) {
      this.logger.info(
        { payload },
        '[MOCK FCM] Push notification simulated successfully (credentials not configured)'
      )
      return
    }

    const start = process.hrtime()
    try {
      const accessToken = await this.getAccessToken()

      const url = `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`

      // Format payload according to FCM HTTP v1 spec
      const fcmMessage: any = {
        token: payload.token,
      }

      if (payload.title || payload.body) {
        fcmMessage.notification = {
          title: payload.title,
          body: payload.body,
        }
      }

      if (payload.data) {
        fcmMessage.data = payload.data
      }

      // Add APNS headers for silent background wakeups on iOS
      if (payload.silent) {
        fcmMessage.apns = {
          payload: {
            aps: {
              'content-available': 1,
            },
          },
          headers: {
            'apns-push-type': 'background',
            'apns-priority': '5',
          },
        }
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: fcmMessage }),
      })

      const duration = process.hrtime(start)
      const durationSeconds = duration[0] + duration[1] / 1e9
      externalApiCallDurationSeconds.observe({ service: 'fcm' }, durationSeconds)

      if (!response.ok) {
        const errorText = await response.text()
        this.logger.error(
          { status: response.status, errorText, token: payload.token },
          'FCM API returned error response'
        )
        externalApiCallsTotal.inc({ service: 'fcm', status: response.status.toString() })
        throw new Error(`FCM API failed with status ${response.status}: ${errorText}`)
      }

      externalApiCallsTotal.inc({ service: 'fcm', status: '200' })
    } catch (err: unknown) {
      const duration = process.hrtime(start)
      const durationSeconds = duration[0] + duration[1] / 1e9
      externalApiCallDurationSeconds.observe({ service: 'fcm' }, durationSeconds)
      externalApiCallsTotal.inc({ service: 'fcm', status: 'error' })
      throw err
    }
  }

  private async getAccessToken(): Promise<string> {
    // Return cached token if valid (using 5 minute safety buffer)
    if (this.cachedAccessToken && Date.now() < this.tokenExpiryEpochMs - 300000) {
      return this.cachedAccessToken
    }

    if (!this.clientEmail || !this.privateKey) {
      throw new Error('Firebase client email or private key is missing')
    }

    try {
      const privateKey = await jose.importPKCS8(this.privateKey, 'RS256')
      const jwt = await new jose.SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(this.clientEmail)
        .setSubject(this.clientEmail)
        .setAudience('https://oauth2.googleapis.com/token')
        .setExpirationTime('1h')
        .setIssuedAt()
        .sign(privateKey)

      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwt,
        }),
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`OAuth token fetch failed: ${response.status} - ${text}`)
      }

      const data: any = await response.json()
      if (!data.access_token || !data.expires_in) {
        throw new Error('Invalid OAuth response structure')
      }

      this.cachedAccessToken = data.access_token
      this.tokenExpiryEpochMs = Date.now() + Number(data.expires_in) * 1000

      return data.access_token
    } catch (err) {
      this.logger.error({ err }, 'Failed to fetch Google OAuth access token for FCM')
      throw err
    }
  }
}
