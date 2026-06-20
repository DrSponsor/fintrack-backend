import type { INotificationRepository } from '../repositories/notification.repo'
import type { AppLogger } from '../../../core/logger'
import { unregisterTokenBodySchema } from '../schemas/notification.schemas'
import { validationError } from '../../../core/errors/factories'

export type UnregisterTokenUseCaseDeps = {
  readonly notificationRepo: INotificationRepository
  readonly logger: AppLogger
}

export class UnregisterTokenUseCase {
  private readonly notificationRepo: INotificationRepository
  private readonly logger: AppLogger

  public constructor(deps: UnregisterTokenUseCaseDeps) {
    this.notificationRepo = deps.notificationRepo
    this.logger = deps.logger
  }

  public async execute(userId: string, rawBody: unknown): Promise<void> {
    const parsed = unregisterTokenBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      throw validationError(
        firstIssue?.message ?? 'Validation failed',
        firstIssue?.path[0] !== undefined ? String(firstIssue.path[0]) : undefined
      )
    }

    const { token } = parsed.data
    await this.notificationRepo.unregisterToken(userId, token)
    
    this.logger.info({ userId, token }, 'Device token unregistered successfully')
  }
}
