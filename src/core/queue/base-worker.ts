import { Worker } from 'bullmq'
import type { ConnectionOptions, Job, Processor, WorkerOptions } from 'bullmq'
import type { AppLogger } from '../logger'
import { workerJobsFailedTotal, workerJobsProcessedTotal, workerProcessingDurationSeconds } from '../observability/metrics'

export type BaseWorkerOptions<TData, TResult> = {
  readonly queueName: string
  readonly connection: ConnectionOptions
  readonly concurrency: number
  readonly logger: AppLogger
  readonly processor: Processor<TData, TResult, string>
}

export class BaseWorker<TData, TResult> {
  private readonly worker: Worker<TData, TResult, string>

  public constructor(options: BaseWorkerOptions<TData, TResult>) {
    this.worker = new Worker<TData, TResult, string>(
      options.queueName,
      this.wrapProcessor(options.queueName, options.processor),
      {
        connection: options.connection,
        concurrency: options.concurrency,
      } satisfies WorkerOptions,
    )

    this.worker.on('completed', (job) => {
      workerJobsProcessedTotal.inc({ queue: options.queueName, job: job.name })
    })

    this.worker.on('failed', (job, error) => {
      workerJobsFailedTotal.inc({ queue: options.queueName, job: job?.name ?? 'unknown' })
      options.logger.error({ err: error, jobId: job?.id, queue: options.queueName }, 'worker job failed')
    })
  }

  public async close(): Promise<void> {
    await this.worker.close()
  }

  private wrapProcessor(
    queueName: string,
    processor: Processor<TData, TResult, string>,
  ): Processor<TData, TResult, string> {
    return async (job: Job<TData, TResult, string>): Promise<TResult> => {
      const end = workerProcessingDurationSeconds.startTimer({ queue: queueName, job: job.name })
      try {
        return await processor(job)
      } finally {
        end()
      }
    }
  }
}
