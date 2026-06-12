import { loadConfig } from './config'
import { buildApp } from './app'
import { createTracingSdk } from './core/observability/tracing'

async function start(): Promise<void> {
  const config = loadConfig()
  const tracing = createTracingSdk(config)
  tracing.start()

  const app = await buildApp({ appConfig: config })

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
