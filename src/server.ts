import { loadConfig } from './config'
import { buildApp } from './app'
import { createTracingSdk } from './core/observability/tracing'

async function start(): Promise<void> {
  const config = loadConfig()
  const tracing = createTracingSdk(config)
  tracing.start()

  // Workers run here when RUN_WORKERS is set. See AppConfig.runWorkers for why
  // this exists: without it nothing consumes the queues in production.
  const app = await buildApp({ appConfig: config, runWorkers: config.runWorkers })

  // Said out loud on every boot, because the absence of this was the bug.
  // Nothing anywhere announced that the queues had no consumer, so a Gmail
  // push looked identical to a working system right up until you went looking
  // for the transaction it should have produced.
  app.log.info(
    { runWorkers: config.runWorkers },
    config.runWorkers
      ? 'API process is ALSO consuming queue workers'
      : 'API process is NOT consuming queues — a separate worker process must be running',
  )

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, 'graceful shutdown started')
    await app.close()
    await tracing.shutdown()
    app.log.info({ signal }, 'graceful shutdown complete')
    process.exit(0)
  }

  process.once('SIGTERM', (signal) => {
    shutdown(signal).catch((error: unknown) => {
      app.log.fatal({ err: error }, 'graceful shutdown failed')
      process.exit(1)
    })
  })

  process.once('SIGINT', (signal) => {
    shutdown(signal).catch((error: unknown) => {
      app.log.fatal({ err: error }, 'graceful shutdown failed')
      process.exit(1)
    })
  })

  await app.listen({ host: config.host, port: config.port })
}

start().catch((error: unknown) => {
  process.stderr.write(`fatal startup failure: ${String(error)}\n`)
  process.exit(1)
})
