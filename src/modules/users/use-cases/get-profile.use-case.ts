import type { AppLogger } from '../../../core/logger'
import type { IUserProfileRepository, UserProfile } from '../repositories/user-profile.repo'
import { notFound } from '../../../core/errors/factories'

export type GetProfileUseCaseDeps = {
  readonly userProfileRepo: IUserProfileRepository
  readonly logger: AppLogger
}

export class GetProfileUseCase {
  private readonly userProfileRepo: IUserProfileRepository
  private readonly logger: AppLogger

  public constructor(deps: GetProfileUseCaseDeps) {
    this.userProfileRepo = deps.userProfileRepo
    this.logger = deps.logger
  }

  public async execute(userId: string): Promise<UserProfile> {
    const profile = await this.userProfileRepo.findById(userId)
    if (profile === null) {
      this.logger.error({ userId }, 'authenticated user not found in DB — token may reference deleted user')
      throw notFound('User not found')
    }
    return profile
  }
}
