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

    // 'failed' is one job going wrong. 'error' is the worker ITSELF in trouble
    // — a dropped Redis connection, a command rejected mid-flight — and it must
    // be listened for rather than left to Node.
    //
    // An 'error' event with no listener does not pass quietly: EventEmitter
    // rethrows it, and an unhandled throw ends the process. That was tolerable
    // while workers had a process of their own, where the blast radius was the
    // worker. They now run inside the API (see AppConfig.runWorkers), so the
    // same Redis blip would take the HTTP server down with them.
    //
    // Logged, not rethrown: BullMQ reconnects on its own, and jobs are durable
    // in Redis, so the honest response to a transient connection fault is to
    // record it and let the worker recover.
    this.worker.on('error', (error) => {
      options.logger.error({ err: error, queue: options.queueName }, 'worker error')
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
