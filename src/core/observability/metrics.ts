import client from 'prom-client'

export const metricsRegistry = new client.Registry()

client.collectDefaultMetrics({
  register: metricsRegistry,
  prefix: 'fintrack_',
})

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests.',
  labelNames: ['method', 'route', 'status'] as const,
})

export const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
})

export const workerJobsProcessedTotal = new client.Counter({
  name: 'worker_jobs_processed_total',
  help: 'Total worker jobs processed.',
  labelNames: ['queue', 'job'] as const,
})

export const workerJobsFailedTotal = new client.Counter({
  name: 'worker_jobs_failed_total',
  help: 'Total worker jobs failed.',
  labelNames: ['queue', 'job'] as const,
})

export const workerProcessingDurationSeconds = new client.Histogram({
  name: 'worker_processing_duration_seconds',
  help: 'Worker processing duration in seconds.',
  labelNames: ['queue', 'job'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
})

export const queueDepthGauge = new client.Gauge({
  name: 'queue_depth',
  help: 'Queue waiting job depth.',
  labelNames: ['queue'] as const,
})

export const dlqDepthGauge = new client.Gauge({
  name: 'dlq_depth',
  help: 'Dead-letter queue depth.',
  labelNames: ['queue'] as const,
})

export const transactionsCapturedTotal = new client.Counter({
  name: 'transactions_captured_total',
  help: 'Total transactions captured by source.',
  labelNames: ['source'] as const,
})

export const transactionsDeduplicatedTotal = new client.Counter({
  name: 'transactions_deduplicated_total',
  help: 'Total deduplicated transactions.',
})

export const parserFallbackToAiTotal = new client.Counter({
  name: 'parser_fallback_to_ai_total',
  help: 'Total parser fallbacks to AI.',
  labelNames: ['domain'] as const,
})

export const aiApiCostUsdTotal = new client.Counter({
  name: 'ai_api_cost_usd_total',
  help: 'Total AI API cost in USD.',
  labelNames: ['provider', 'use_case'] as const,
})

export const gmailApiCallsTotal = new client.Counter({
  name: 'gmail_api_calls_total',
  help: 'Total Gmail API calls.',
})

export const gmailApi429Total = new client.Counter({
  name: 'gmail_api_429_total',
  help: 'Total Gmail API 429 responses.',
})

export const webhooksUnresolvableTotal = new client.Counter({
  name: 'webhooks_unresolvable_total',
  help: 'Total provider webhooks that cannot be resolved to a user.',
})

export const circuitBreakerStateGauge = new client.Gauge({
  name: 'circuit_breaker_state',
  help: 'Circuit breaker state (0 = closed, 1 = open, 2 = half-open).',
  labelNames: ['name'] as const,
})

export const externalApiCallsTotal = new client.Counter({
  name: 'external_api_calls_total',
  help: 'Total external service API calls.',
  labelNames: ['service', 'status'] as const,
})

export const externalApiCallDurationSeconds = new client.Histogram({
  name: 'external_api_call_duration_seconds',
  help: 'External service API call duration in seconds.',
  labelNames: ['service'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 3, 5, 10],
})

metricsRegistry.registerMetric(httpRequestsTotal)
metricsRegistry.registerMetric(httpRequestDurationSeconds)
metricsRegistry.registerMetric(workerJobsProcessedTotal)
metricsRegistry.registerMetric(workerJobsFailedTotal)
metricsRegistry.registerMetric(workerProcessingDurationSeconds)
metricsRegistry.registerMetric(queueDepthGauge)
metricsRegistry.registerMetric(dlqDepthGauge)
metricsRegistry.registerMetric(transactionsCapturedTotal)
metricsRegistry.registerMetric(transactionsDeduplicatedTotal)
metricsRegistry.registerMetric(parserFallbackToAiTotal)
metricsRegistry.registerMetric(aiApiCostUsdTotal)
metricsRegistry.registerMetric(gmailApiCallsTotal)
metricsRegistry.registerMetric(gmailApi429Total)
metricsRegistry.registerMetric(webhooksUnresolvableTotal)
metricsRegistry.registerMetric(circuitBreakerStateGauge)
metricsRegistry.registerMetric(externalApiCallsTotal)
metricsRegistry.registerMetric(externalApiCallDurationSeconds)

