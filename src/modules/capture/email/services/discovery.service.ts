import type { Queue } from 'bullmq'
import type { AppLogger } from '../../../../core/logger'
import { AppError } from '../../../../core/errors/AppError'
import { ERROR_CODES } from '../../../../core/errors/codes'
import { tokenRevoked } from '../../../../core/errors/factories'

export type DiscoveryServiceDeps = {
  readonly captureEmailQueue: Queue
  readonly logger: AppLogger
}

export class DiscoveryService {
  private readonly queue: Queue
  private readonly logger: AppLogger

  public constructor(deps: DiscoveryServiceDeps) {
    this.queue = deps.captureEmailQueue
    this.logger = deps.logger
  }

  public async syncHistory(
    accountId: string,
    startHistoryId: string,
    accessToken: string,
    lastTxDate: Date | null,
  ): Promise<string | null> {
    try {
      return await this.fetchHistory(accountId, startHistoryId, accessToken)
    } catch (err) {
      // If history expired (Google returns 400 or 404 for stale historyId)
      if (
        err instanceof AppError &&
        (err.statusCode === 400 || err.statusCode === 404)
      ) {
        this.logger.warn(
          { accountId, startHistoryId },
          'Gmail history ID expired or invalid. Falling back to message list discovery.',
        )
        return await this.fallbackListMessages(accountId, accessToken, lastTxDate)
      }
      throw err
    }
  }

  private async fetchHistory(
    accountId: string,
    startHistoryId: string,
    accessToken: string,
  ): Promise<string | null> {
    let pageToken: string | undefined = undefined
    let latestHistoryId: string | null = null
    const messageIds = new Set<string>()

    do {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history')
      url.searchParams.set('startHistoryId', startHistoryId)
      url.searchParams.set('historyTypes', 'messageAdded')
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken)
      }

      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (!response.ok) {
        const errorText = await response.text()
        if (response.status === 401 || response.status === 403) {
          throw tokenRevoked('Gmail credentials unauthorized during history sync')
        }
        throw new AppError(
          ERROR_CODES.DEPENDENCY_UNAVAILABLE,
          `Gmail history list failed: ${response.statusText}`,
          response.status,
        )
      }

      const json = await response.json() as {
        readonly history?: readonly {
          readonly id: string
          readonly messagesAdded?: readonly {
            readonly message?: {
              readonly id?: string
            }
          }[]
        }[]
        readonly nextPageToken?: string
        readonly historyId?: string
      }

      if (json.historyId) {
        latestHistoryId = json.historyId
      }

      if (json.history) {
        for (const historyRecord of json.history) {
          if (historyRecord.messagesAdded) {
            for (const item of historyRecord.messagesAdded) {
              const msgId = item.message?.id
              if (msgId) {
                messageIds.add(msgId)
              }
            }
          }
        }
      }

      pageToken = json.nextPageToken
    } while (pageToken)

    if (messageIds.size > 0) {
      this.logger.info({ accountId, count: messageIds.size }, 'Discovered new messages via history sync. Queueing ingestion jobs.')
      await this.queueJobs(accountId, Array.from(messageIds))
    }

    return latestHistoryId
  }

  private async fallbackListMessages(
    accountId: string,
    accessToken: string,
    lastTxDate: Date | null,
  ): Promise<string | null> {
    // Determine the "after" query. If lastTxDate exists, use it. Otherwise, query from last 24 hours.
    const sinceDate = lastTxDate ? new Date(lastTxDate.getTime() - 3600_000) : new Date(Date.now() - 24 * 3600_000)
    // Format as YYYY/MM/DD
    const yyyy = sinceDate.getFullYear()
    const mm = String(sinceDate.getMonth() + 1).padStart(2, '0')
    const dd = String(sinceDate.getDate()).padStart(2, '0')
    const query = `after:${yyyy}/${mm}/${dd}`

    let pageToken: string | undefined = undefined
    const messageIds = new Set<string>()

    do {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
      url.searchParams.set('q', query)
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken)
      }

      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (!response.ok) {
        const errorText = await response.text()
        if (response.status === 401 || response.status === 403) {
          throw tokenRevoked('Gmail credentials unauthorized during fallback list')
        }
        throw new AppError(
          ERROR_CODES.DEPENDENCY_UNAVAILABLE,
          `Gmail message list failed: ${response.statusText}`,
          response.status,
        )
      }

      const json = await response.json() as {
        readonly messages?: readonly { readonly id: string }[]
        readonly nextPageToken?: string
      }

      if (json.messages) {
        for (const msg of json.messages) {
          messageIds.add(msg.id)
        }
      }

      pageToken = json.nextPageToken
    } while (pageToken)

    if (messageIds.size > 0) {
      this.logger.info(
        { accountId, count: messageIds.size, query },
        'Discovered new messages via fallback list. Queueing ingestion jobs.',
      )
      await this.queueJobs(accountId, Array.from(messageIds))
    }

    // Since we did a full list, get the latest historyId by querying the user profile
    const profileResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (profileResponse.ok) {
      const profile = await profileResponse.json() as { readonly historyId?: string }
      return profile.historyId ?? null
    }

    return null
  }

  private async queueJobs(accountId: string, messageIds: readonly string[]): Promise<void> {
    for (const messageId of messageIds) {
      await this.queue.add(
        'ingest-message',
        { accountId, messageId },
        {
          jobId: `email-ingest:${accountId}:${messageId}`, // Deduplicate
        },
      )
    }
  }
}
