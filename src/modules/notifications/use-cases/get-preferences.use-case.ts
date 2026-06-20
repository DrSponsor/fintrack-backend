import type { INotificationRepository, NotificationPreferenceRecord } from '../repositories/notification.repo'
import type { AppLogger } from '../../../core/logger'

export type GetPreferencesUseCaseDeps = {
  readonly notificationRepo: INotificationRepository
  readonly logger: AppLogger
}

export class GetPreferencesUseCase {
  private readonly notificationRepo: INotificationRepository
  private readonly logger: AppLogger

  public constructor(deps: GetPreferencesUseCaseDeps) {
    this.notificationRepo = deps.notificationRepo
    this.logger = deps.logger
  }

  public async execute(userId: string): Promise<NotificationPreferenceRecord> {
    const record = await this.notificationRepo.getPreferences(userId)
    this.logger.debug({ userId }, 'Retrieved notification preferences')
    return record
  }
}
