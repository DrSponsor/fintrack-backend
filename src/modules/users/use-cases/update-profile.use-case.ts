import type { AppLogger } from '../../../core/logger'
import type { IUserProfileRepository, UserProfile } from '../repositories/user-profile.repo'
import { notFound, validationError } from '../../../core/errors/factories'
import { updateProfileBodySchema } from '../schemas/user.schemas'

export type UpdateProfileUseCaseDeps = {
  readonly userProfileRepo: IUserProfileRepository
  readonly logger: AppLogger
}

export class UpdateProfileUseCase {
  private readonly userProfileRepo: IUserProfileRepository
  private readonly logger: AppLogger

  public constructor(deps: UpdateProfileUseCaseDeps) {
    this.userProfileRepo = deps.userProfileRepo
    this.logger = deps.logger
  }

  public async execute(userId: string, rawBody: unknown): Promise<UserProfile> {
    const parsed = updateProfileBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      throw validationError(
        firstIssue?.message ?? 'Validation failed',
        firstIssue?.path[0] !== undefined ? String(firstIssue.path[0]) : undefined,
      )
    }

    // Verify user exists before update
    const existing = await this.userProfileRepo.findById(userId)
    if (existing === null) {
      throw notFound('User not found')
    }

    const updated = await this.userProfileRepo.update(userId, parsed.data)
    this.logger.info({ userId }, 'user profile updated')

    return updated
  }
}
