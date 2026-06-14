import 'dotenv/config'
import { z } from 'zod'

const nodeEnvSchema = z.enum(['development', 'test', 'staging', 'production'])

const portSchema = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value)
  }
  return value
}, z.number().int().min(1).max(65_535))

const commaListSchema = z.preprocess((value) => {
  if (typeof value !== 'string' || value.trim() === '') {
    return []
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}, z.array(z.string().url()))

const envSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: portSchema.default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url().refine((value) => value.includes('pgbouncer=true'), {
    message: 'DATABASE_URL must include ?pgbouncer=true for PgBouncer transaction mode',
  }),
  DIRECT_URL: z.string().url(),
  READ_REPLICA_DATABASE_URL: z.string().url().optional().or(z.literal('')),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  CORS_ORIGINS: commaListSchema.default([]),
  FIELD_ENCRYPTION_KEY_BASE64: z.string().min(1),
  JWT_PUBLIC_KEY_PEM: z.string().optional().or(z.literal('')),
  JWT_PRIVATE_KEY_PEM: z.string().optional().or(z.literal('')),
  DEEPSEEK_API_KEY: z.string().optional().or(z.literal('')),
}).superRefine((value, context) => {
  const key = Buffer.from(value.FIELD_ENCRYPTION_KEY_BASE64, 'base64')
  if (key.byteLength !== 32) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['FIELD_ENCRYPTION_KEY_BASE64'],
      message: 'FIELD_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes',
    })
  }

  if (value.NODE_ENV === 'production') {
    if (!value.JWT_PUBLIC_KEY_PEM) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_PUBLIC_KEY_PEM'],
        message: 'JWT_PUBLIC_KEY_PEM is required in production',
      })
    }
    if (!value.JWT_PRIVATE_KEY_PEM) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_PRIVATE_KEY_PEM'],
        message: 'JWT_PRIVATE_KEY_PEM is required in production',
      })
    }
  }
})

export type AppConfig = {
  readonly nodeEnv: z.infer<typeof nodeEnvSchema>
  readonly host: string
  readonly port: number
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'
  readonly databaseUrl: string
  readonly directUrl: string
  readonly readReplicaDatabaseUrl: string
  readonly redisUrl: string
  readonly corsOrigins: readonly string[]
  readonly fieldEncryptionKeyBase64: string
  readonly jwtPublicKeyPem?: string
  readonly jwtPrivateKeyPem?: string
  readonly deepseekApiKey?: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env)
  const replicaUrl = parsed.READ_REPLICA_DATABASE_URL && parsed.READ_REPLICA_DATABASE_URL.length > 0
    ? parsed.READ_REPLICA_DATABASE_URL
    : parsed.DATABASE_URL

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    directUrl: parsed.DIRECT_URL,
    readReplicaDatabaseUrl: replicaUrl,
    redisUrl: parsed.REDIS_URL,
    corsOrigins: parsed.CORS_ORIGINS,
    fieldEncryptionKeyBase64: parsed.FIELD_ENCRYPTION_KEY_BASE64,
    ...(parsed.JWT_PUBLIC_KEY_PEM ? { jwtPublicKeyPem: parsed.JWT_PUBLIC_KEY_PEM } : {}),
    ...(parsed.JWT_PRIVATE_KEY_PEM ? { jwtPrivateKeyPem: parsed.JWT_PRIVATE_KEY_PEM } : {}),
    ...(parsed.DEEPSEEK_API_KEY ? { deepseekApiKey: parsed.DEEPSEEK_API_KEY } : {}),
  }
}
