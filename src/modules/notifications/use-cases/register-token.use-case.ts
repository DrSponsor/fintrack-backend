import type { INotificationRepository, DeviceTokenRecord } from '../repositories/notification.repo'
import type { AppLogger } from '../../../core/logger'
import { registerTokenBodySchema } from '../schemas/notification.schemas'
import { validationError } from '../../../core/errors/factories'

export type RegisterTokenUseCaseDeps = {
  readonly notificationRepo: INotificationRepository
  readonly logger: AppLogger
}

export class RegisterTokenUseCase {
  private readonly notificationRepo: INotificationRepository
  private readonly logger: AppLogger

  public constructor(deps: RegisterTokenUseCaseDeps) {
    this.notificationRepo = deps.notificationRepo
    this.logger = deps.logger
  }

  public async execute(userId: string, rawBody: unknown): Promise<DeviceTokenRecord> {
    const parsed = registerTokenBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      throw validationError(
        firstIssue?.message ?? 'Validation failed',
        firstIssue?.path[0] !== undefined ? String(firstIssue.path[0]) : undefined
      )
    }

    const { token, platform } = parsed.data
    const record = await this.notificationRepo.registerToken(userId, token, platform)
    
    this.logger.info({ userId, token: record.token, platform: record.platform }, 'Device token registered/re-assigned successfully')
    return record
  }
}
