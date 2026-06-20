import type { INotificationRepository, NotificationPreferenceRecord } from '../repositories/notification.repo'
import type { AppLogger } from '../../../core/logger'
import { updatePreferencesBodySchema } from '../schemas/notification.schemas'
import { validationError } from '../../../core/errors/factories'

export type UpdatePreferencesUseCaseDeps = {
  readonly notificationRepo: INotificationRepository
  readonly logger: AppLogger
}

export class UpdatePreferencesUseCase {
  private readonly notificationRepo: INotificationRepository
  private readonly logger: AppLogger

  public constructor(deps: UpdatePreferencesUseCaseDeps) {
    this.notificationRepo = deps.notificationRepo
    this.logger = deps.logger
  }

  public async execute(userId: string, rawBody: unknown): Promise<NotificationPreferenceRecord> {
    const parsed = updatePreferencesBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      throw validationError(
        firstIssue?.message ?? 'Validation failed',
        firstIssue?.path[0] !== undefined ? String(firstIssue.path[0]) : undefined
      )
    }

    const record = await this.notificationRepo.updatePreferences(userId, parsed.data)
    this.logger.info({ userId, updatedPreferences: parsed.data }, 'Notification preferences updated successfully')
    return record
  }
}
