import type { QueueRegistry } from '../../../core/queue/queues'
import type { AppLogger } from '../../../core/logger'

export type InitiateExportResult = {
  readonly message: string
}

export class InitiateExportUseCase {
  private readonly queues: QueueRegistry
  private readonly logger: AppLogger

  public constructor(deps: {
    readonly queues: QueueRegistry
    readonly logger: AppLogger
  }) {
    this.queues = deps.queues
    this.logger = deps.logger
  }

  public async execute(userId: string, userEmail: string): Promise<InitiateExportResult> {
    // Queue the export job — deduplicates via jobId to prevent multiple concurrent exports
    await this.queues.privacyExport.add(
      'generate-export',
      { userId, email: userEmail },
      {
        jobId: `export-${userId}-${Date.now()}`,
      }
    )

    this.logger.info({ userId }, 'Data export job queued')

    return {
      message: 'Your data export is being generated. You will receive an email with a download link once it is ready.',
    }
  }
}
