import type { AppConfig } from '../../../../config'
import type { AppLogger } from '../../../../core/logger'
import { AppError } from '../../../../core/errors/AppError'
import { ERROR_CODES } from '../../../../core/errors/codes'
import { tokenRevoked } from '../../../../core/errors/factories'

export class WatchService {
  private readonly config: AppConfig
  private readonly logger: AppLogger

  public constructor(config: AppConfig, logger: AppLogger) {
    this.config = config
    this.logger = logger
  }

  public async setUpWatch(
    email: string,
    accessToken: string,
  ): Promise<{ readonly historyId: string; readonly expiration: string }> {
    const topicName = this.config.googlePubSubTopic
    
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        topicName,
        labelIds: ['INBOX'],
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      this.logger.error({ email, status: response.status, errorText }, 'Failed to set up Gmail Pub/Sub watch')
      
      if (response.status === 401 || response.status === 403) {
        throw tokenRevoked('Gmail credentials expired or unauthorized for push notifications')
      }

      throw new AppError(
        ERROR_CODES.DEPENDENCY_UNAVAILABLE,
        'Failed to set up Gmail watch subscription',
        503,
      )
    }

    const json = await response.json() as {
      readonly historyId?: string
      readonly expiration?: string
    }

    if (!json.historyId || !json.expiration) {
      throw new AppError(
        ERROR_CODES.DEPENDENCY_UNAVAILABLE,
        'Invalid response format from Google Watch API',
        503,
      )
    }

    this.logger.info({ email, historyId: json.historyId, expiration: json.expiration }, 'Gmail watch successfully set up')

    return {
      historyId: json.historyId,
      expiration: json.expiration,
    }
  }

  public async stopWatch(email: string, accessToken: string): Promise<void> {
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/stop', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    })

    if (!response.ok && response.status !== 401 && response.status !== 403) {
      const errorText = await response.text()
      this.logger.warn({ email, status: response.status, errorText }, 'Failed to stop Gmail watch subscription (best-effort)')
    } else {
      this.logger.info({ email }, 'Gmail watch successfully stopped')
    }
  }
}
