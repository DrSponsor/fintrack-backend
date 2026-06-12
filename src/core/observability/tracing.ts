import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import type { AppConfig } from '../../config'

export function createTracingSdk(appConfig: AppConfig): NodeSDK {
  return new NodeSDK({
    serviceName: `fintrack-backend-${appConfig.nodeEnv}`,
    instrumentations: [getNodeAutoInstrumentations()],
  })
}
