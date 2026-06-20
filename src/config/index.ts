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
  GOOGLE_CLIENT_ID: z.string().optional().or(z.literal('')),
  GOOGLE_CLIENT_SECRET: z.string().optional().or(z.literal('')),
  GOOGLE_REDIRECT_URI: z.string().optional().or(z.literal('')),
  GOOGLE_PUB_SUB_TOPIC: z.string().default('projects/fintrack-prod/topics/gmail-push'),
  PAYSTACK_SECRET_KEY: z.string().optional().or(z.literal('')),
  PAYSTACK_PLAN_PRO_MONTHLY: z.string().optional().or(z.literal('')),
  PAYSTACK_PLAN_PRO_ANNUAL: z.string().optional().or(z.literal('')),
  FIREBASE_PROJECT_ID: z.string().optional().or(z.literal('')),
  FIREBASE_CLIENT_EMAIL: z.string().optional().or(z.literal('')),
  FIREBASE_PRIVATE_KEY: z.string().optional().or(z.literal('')),
  POSTMARK_SERVER_TOKEN: z.string().optional().or(z.literal('')),
  EMAIL_FROM: z.string().default('no-reply@fintrack.ng'),
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
    if (!value.GOOGLE_CLIENT_ID) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GOOGLE_CLIENT_ID'],
        message: 'GOOGLE_CLIENT_ID is required in production',
      })
    }
    if (!value.GOOGLE_CLIENT_SECRET) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GOOGLE_CLIENT_SECRET'],
        message: 'GOOGLE_CLIENT_SECRET is required in production',
      })
    }
    if (!value.GOOGLE_REDIRECT_URI) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GOOGLE_REDIRECT_URI'],
        message: 'GOOGLE_REDIRECT_URI is required in production',
      })
    }
    if (!value.PAYSTACK_SECRET_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYSTACK_SECRET_KEY'],
        message: 'PAYSTACK_SECRET_KEY is required in production',
      })
    }
    if (!value.PAYSTACK_PLAN_PRO_MONTHLY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYSTACK_PLAN_PRO_MONTHLY'],
        message: 'PAYSTACK_PLAN_PRO_MONTHLY is required in production',
      })
    }
    if (!value.PAYSTACK_PLAN_PRO_ANNUAL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYSTACK_PLAN_PRO_ANNUAL'],
        message: 'PAYSTACK_PLAN_PRO_ANNUAL is required in production',
      })
    }
    if (!value.FIREBASE_PROJECT_ID) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIREBASE_PROJECT_ID'],
        message: 'FIREBASE_PROJECT_ID is required in production',
      })
    }
    if (!value.FIREBASE_CLIENT_EMAIL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIREBASE_CLIENT_EMAIL'],
        message: 'FIREBASE_CLIENT_EMAIL is required in production',
      })
    }
    if (!value.FIREBASE_PRIVATE_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIREBASE_PRIVATE_KEY'],
        message: 'FIREBASE_PRIVATE_KEY is required in production',
      })
    }
    if (!value.POSTMARK_SERVER_TOKEN) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['POSTMARK_SERVER_TOKEN'],
        message: 'POSTMARK_SERVER_TOKEN is required in production',
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
  readonly googleClientId?: string
  readonly googleClientSecret?: string
  readonly googleRedirectUri?: string
  readonly googlePubSubTopic: string
  readonly paystackSecretKey?: string
  readonly paystackPlanProMonthly?: string
  readonly paystackPlanProAnnual?: string
  readonly firebaseProjectId?: string
  readonly firebaseClientEmail?: string
  readonly firebasePrivateKey?: string
  readonly postmarkServerToken?: string
  readonly emailFrom: string
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
    ...(parsed.GOOGLE_CLIENT_ID ? { googleClientId: parsed.GOOGLE_CLIENT_ID } : {}),
    ...(parsed.GOOGLE_CLIENT_SECRET ? { googleClientSecret: parsed.GOOGLE_CLIENT_SECRET } : {}),
    ...(parsed.GOOGLE_REDIRECT_URI ? { googleRedirectUri: parsed.GOOGLE_REDIRECT_URI } : {}),
    googlePubSubTopic: parsed.GOOGLE_PUB_SUB_TOPIC,
    paystackSecretKey: parsed.PAYSTACK_SECRET_KEY || 'ts_paystack_secret_key_fallback',
    paystackPlanProMonthly: parsed.PAYSTACK_PLAN_PRO_MONTHLY || 'PLN_test_monthly',
    paystackPlanProAnnual: parsed.PAYSTACK_PLAN_PRO_ANNUAL || 'PLN_test_annual',
    ...(parsed.FIREBASE_PROJECT_ID ? { firebaseProjectId: parsed.FIREBASE_PROJECT_ID } : {}),
    ...(parsed.FIREBASE_CLIENT_EMAIL ? { firebaseClientEmail: parsed.FIREBASE_CLIENT_EMAIL } : {}),
    ...(parsed.FIREBASE_PRIVATE_KEY ? { firebasePrivateKey: parsed.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') } : {}),
    ...(parsed.POSTMARK_SERVER_TOKEN ? { postmarkServerToken: parsed.POSTMARK_SERVER_TOKEN } : {}),
    emailFrom: parsed.EMAIL_FROM,
  }
}
