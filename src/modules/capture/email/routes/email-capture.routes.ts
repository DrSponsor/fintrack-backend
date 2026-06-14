import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ConnectGmailUseCase } from '../services/connect-gmail.use-case'
import { DisconnectGmailUseCase } from '../services/disconnect-gmail.use-case'
import { ProcessGmailWebhookUseCase } from '../services/process-gmail-webhook.use-case'
import { OAuthService } from '../services/oauth.service'
import { WatchService } from '../services/watch.service'
import { PrismaAccountRepository } from '../../../accounts/repositories/account.repo'
import { authenticate } from '../../../../core/middleware/authenticate'
import { successEnvelope } from '../../../../core/http/envelope'
import { validationError } from '../../../../core/errors/factories'

const oauthCallbackBodySchema = z.object({
  accountId: z.string().uuid('Invalid account ID'),
  code: z.string().min(1, 'Authorization code is required'),
}).strict()

const oauthDisconnectBodySchema = z.object({
  accountId: z.string().uuid('Invalid account ID'),
}).strict()

const pubSubPayloadSchema = z.object({
  message: z.object({
    data: z.string(),
    messageId: z.string(),
    publishTime: z.string(),
  }),
  subscription: z.string(),
}).strict()

const gmailDecodedDataSchema = z.object({
  emailAddress: z.string().email(),
  historyId: z.union([z.number(), z.string()]),
}).strict()

export function registerEmailCaptureRoutes(fastify: FastifyInstance<any, any, any, any, any>): void {
  const accountRepo = new PrismaAccountRepository(fastify.db.primary)
  const oauthService = new OAuthService(fastify.appConfig, accountRepo, fastify.log)
  const watchService = new WatchService(fastify.appConfig, fastify.log)

  const connectGmailUseCase = new ConnectGmailUseCase({
    accountRepo,
    oauthService,
    watchService,
    captureEmailQueue: fastify.queues.captureEmail,
  })

  const disconnectGmailUseCase = new DisconnectGmailUseCase({
    accountRepo,
    oauthService,
  })

  const processGmailWebhookUseCase = new ProcessGmailWebhookUseCase({
    prisma: fastify.db.primary,
    captureEmailQueue: fastify.queues.captureEmail,
  })

  // 1. Google OAuth callback: registers auth code, exchanges for token, and starts watch
  fastify.post(
    '/v1/capture/email/oauth/callback',
    {
      preHandler: [authenticate],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['accountId', 'code'],
          properties: {
            accountId: { type: 'string', format: 'uuid' },
            code: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['success', 'data', 'requestId'],
            properties: {
              success: { type: 'boolean', const: true },
              data: {
                type: 'object',
                additionalProperties: false,
                required: ['email'],
                properties: {
                  email: { type: 'string' },
                },
              },
              requestId: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = oauthCallbackBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw validationError(parsed.error.issues[0]?.message ?? 'Invalid request body')
      }

      const { accountId, code } = parsed.data
      const { email } = await connectGmailUseCase.execute(request.user!.sub, accountId, code)

      return reply.code(200).send(successEnvelope({ email }, request.requestId))
    },
  )

  // 2. Disconnect mailbox
  fastify.post(
    '/v1/capture/email/oauth/disconnect',
    {
      preHandler: [authenticate],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['accountId'],
          properties: {
            accountId: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['success', 'data', 'requestId'],
            properties: {
              success: { type: 'boolean', const: true },
              data: { type: 'null' },
              requestId: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = oauthDisconnectBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw validationError(parsed.error.issues[0]?.message ?? 'Invalid request body')
      }

      const { accountId } = parsed.data
      await disconnectGmailUseCase.execute(request.user!.sub, accountId)

      return reply.code(200).send(successEnvelope(null, request.requestId))
    },
  )

  // 3. Pub/Sub push webhook endpoint
  fastify.post(
    '/v1/capture/email/pubsub',
    {
      schema: {
        body: {
          type: 'object',
          required: ['message'],
          properties: {
            message: {
              type: 'object',
              required: ['data', 'messageId', 'publishTime'],
              properties: {
                data: { type: 'string' },
                messageId: { type: 'string' },
                publishTime: { type: 'string' },
              },
            },
            subscription: { type: 'string' },
          },
        },
        response: {
          202: {
            type: 'object',
            additionalProperties: false,
            required: ['success', 'data', 'requestId'],
            properties: {
              success: { type: 'boolean', const: true },
              data: { type: 'null' },
              requestId: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = pubSubPayloadSchema.safeParse(request.body)
      if (!parsed.success) {
        request.log.warn({ issues: parsed.error.issues }, 'Invalid Pub/Sub webhook payload structure')
        throw validationError('Invalid Pub/Sub webhook payload structure')
      }

      const { data } = parsed.data.message
      let decodedString: string
      try {
        decodedString = Buffer.from(data, 'base64').toString('utf8')
      } catch (err) {
        request.log.warn({ err }, 'Failed to decode base64 Pub/Sub message data')
        throw validationError('Invalid base64 encoding')
      }

      let decodedJson: unknown
      try {
        decodedJson = JSON.parse(decodedString)
      } catch (err) {
        request.log.warn({ err, decodedString }, 'Failed to parse Pub/Sub data JSON string')
        throw validationError('Invalid JSON payload in message data')
      }

      const decodedParsed = gmailDecodedDataSchema.safeParse(decodedJson)
      if (!decodedParsed.success) {
        request.log.warn({ issues: decodedParsed.error.issues, decodedJson }, 'Pub/Sub message data did not match Gmail schema')
        throw validationError('Invalid Gmail schema inside data payload')
      }

      const { emailAddress, historyId } = decodedParsed.data
      const queueCount = await processGmailWebhookUseCase.execute(emailAddress, String(historyId))

      request.log.info({ emailAddress, historyId, queueCount }, 'Processed Pub/Sub webhook and queued history syncs')

      return reply.code(202).send(successEnvelope(null, request.requestId))
    },
  )
}
