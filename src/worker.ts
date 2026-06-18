import { loadConfig } from './config'
import { buildApp } from './app'
import { createTracingSdk } from './core/observability/tracing'
import { dlqDepthGauge, queueDepthGauge } from './core/observability/metrics'

async function start(): Promise<void> {
  const config = loadConfig()
  const tracing = createTracingSdk(config)
  tracing.start()

  // Build the app and enable worker initialization plugin registration
  const app = await buildApp({
    appConfig: config,
    runWorkers: true,
  })

  app.log.info('Worker process successfully initialized.')

  // Periodically poll queue and DLQ (failed) depths to export to Prometheus
  const intervalId = setInterval(async () => {
    try {
      const queues = [
        app.queues.captureEmail,
        app.queues.captureManual,
        app.queues.analysisWeekly,
        app.queues.analysisMonthly,
        app.queues.notificationsPush,
        app.queues.watchRenewal,
        app.queues.billingWebhooks,
      ]

      for (const q of queues) {
        try {
          const failedCount = await q.getFailedCount()
          const waitingCount = await q.getWaitingCount()
          dlqDepthGauge.set({ queue: q.name }, failedCount)
          queueDepthGauge.set({ queue: q.name }, waitingCount)
        } catch (error) {
          app.log.error({ err: error, queue: q.name }, 'Failed to poll queue metrics')
        }
      }
    } catch (error) {
      app.log.error({ err: error }, 'Queue metrics polling cycle failed')
    }
  }, 60_000)

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'Worker process graceful shutdown started')
    clearInterval(intervalId)
    await app.close()
    await tracing.shutdown()
    app.log.info({ signal }, 'Worker process graceful shutdown complete')
    process.exit(0)
  }

  process.once('SIGTERM', (signal) => {
    shutdown(signal).catch((error: unknown) => {
      app.log.fatal({ err: error }, 'Worker process graceful shutdown failed')
      process.exit(1)
    })
  })

  process.once('SIGINT', (signal) => {
    shutdown(signal).catch((error: unknown) => {
      app.log.fatal({ err: error }, 'Worker process graceful shutdown failed')
      process.exit(1)
    })
  })
}

start().catch((error: unknown) => {
  process.stderr.write(`fatal worker startup failure: ${String(error)}\n`)
  process.exit(1)
})
