import type { AppFastifyInstance } from '../../../../types/fastify'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { ConnectGmailUseCase } from '../services/connect-gmail.use-case'
import { DisconnectGmailUseCase } from '../services/disconnect-gmail.use-case'
import { ProcessGmailWebhookUseCase } from '../services/process-gmail-webhook.use-case'
import { OAuthService } from '../services/oauth.service'
import { FetchService } from '../services/fetch.service'
import { SafetyFilterService } from '../services/safety-filter.service'
import { AccountDiscoveryService } from '../services/account-discovery.service'
import { DiscoverAccountsUseCase } from '../services/discover-accounts.use-case'
import { ConfirmAccountsUseCase } from '../services/confirm-accounts.use-case'
import { PrismaAccountRepository } from '../../../accounts/repositories/account.repo'
import { PrismaGmailConnectionRepository } from '../repositories/gmail-connection.repo'
import { WatchService } from '../services/watch.service'
import { authenticate, requireUser } from '../../../../core/middleware/authenticate'
import { successEnvelope } from '../../../../core/http/envelope'
import { validationError } from '../../../../core/errors/factories'

// No accountId. The inbox is connected to the PERSON, and the accounts are
// what the app then finds inside it — which is the whole point of the change.
const oauthCallbackBodySchema = z.object({
  code: z.string().min(1, 'Authorization code is required'),
}).strict()

// Nothing to name: a caller can only disconnect their own inbox.
const oauthDisconnectBodySchema = z.object({}).strict()

const confirmAccountsBodySchema = z.object({
  accounts: z
    .array(
      z.object({
        bankName: z.string().min(1).max(100).trim(),
        // Nullable: some wallets never print the owner's own account number.
        // See ConfirmedAccountInput.
        accountMask: z.string().min(1).max(64).trim().nullable().optional(),
        holderName: z.string().max(120).trim().nullable().optional(),
        accountType: z.enum(['CURRENT', 'SAVINGS', 'WALLET']),
      }),
    )
    .max(20, 'Too many accounts confirmed at once'),
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

/**
 * Escapes text destined for HTML.
 *
 * Everything interpolated into the callback page arrives in a query string an
 * attacker can craft, so all of it is untrusted. The ampersand is replaced
 * FIRST — doing it later would re-escape the ampersands introduced by the other
 * replacements and emit `&amp;lt;`.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Wraps the callback message in a self-contained page. Dark, to match the app
 *  the user is being handed back to rather than flashing white at them. */
function page(body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FinTrack</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#080B12; color:#ECEDF2; text-align:center; padding:24px;
         font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif }
  main { max-width:420px }
  h1 { font-size:22px; letter-spacing:-0.3px; margin:0 0 12px }
  p { color:#8A90A6; line-height:1.5; margin:0 0 16px }
  .muted { font-size:13px }
  code { display:block; background:#171D2E; border:1px solid rgba(255,255,255,.16);
         border-radius:6px; padding:12px; font-size:12px; word-break:break-all; color:#ECEDF2 }
  .btn { display:inline-block; background:#F0EDE6; color:#0A0D14; text-decoration:none;
         padding:14px 24px; border-radius:10px; font-weight:600 }
</style>
</head><body><main>${body}</main></body></html>`
}

export function registerEmailCaptureRoutes(fastify: AppFastifyInstance): void {
  const connectionRepo = new PrismaGmailConnectionRepository(fastify.db.primary)
  const oauthService = new OAuthService(fastify.appConfig, connectionRepo, fastify.log)
  const watchService = new WatchService(fastify.appConfig, fastify.log)

  const connectGmailUseCase = new ConnectGmailUseCase({
    connectionRepo,
    oauthService,
    watchService,
    captureEmailQueue: fastify.queues.captureEmail,
    logger: fastify.log,
  })

  const disconnectGmailUseCase = new DisconnectGmailUseCase({
    oauthService,
  })

  const discoverAccountsUseCase = new DiscoverAccountsUseCase({
    oauthService,
    fetchService: new FetchService(fastify.log),
    safetyFilter: new SafetyFilterService(),
    discovery: new AccountDiscoveryService({ aiProvider: fastify.ai, logger: fastify.log }),
    accountRepo: new PrismaAccountRepository(fastify.db.primary),
    logger: fastify.log,
  })

  const confirmAccountsUseCase = new ConfirmAccountsUseCase({
    prisma: fastify.db.primary,
    logger: fastify.log,
  })

  const processGmailWebhookUseCase = new ProcessGmailWebhookUseCase({
    connectionRepo,
    captureEmailQueue: fastify.queues.captureEmail,
    logger: fastify.log,
  })

  // 0a. Consent URL — the entry point to the whole flow.
  //
  // Nothing previously exposed OAuthService.getConsentUrl, so the client had no
  // way to BEGIN authorization: the exchange endpoint below existed, but the
  // step that produces the code it consumes did not.
  //
  // The `state` is minted here and returned alongside the URL. The client keeps
  // it and must refuse any redirect that comes back with a different one.
  fastify.get(
    '/v1/capture/email/oauth/url',
    {
      preHandler: [authenticate],
      schema: {
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
                required: ['consentUrl', 'state'],
                properties: {
                  consentUrl: { type: 'string' },
                  state: { type: 'string' },
                },
              },
              requestId: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const state = randomBytes(16).toString('hex')
      return reply
        .code(200)
        .send(successEnvelope({ consentUrl: oauthService.getConsentUrl(state), state }, request.requestId))
    },
  )

  // 0b. Google's redirect target.
  //
  // GET and UNAUTHENTICATED, both necessarily: Google completes authorization
  // by redirecting a browser here, and a browser redirect carries no bearer
  // token. The POST route below shares this path but not its method, which
  // Fastify routes independently.
  //
  // This endpoint deliberately does NOT exchange the code. It is a relay: it
  // hands the code back to the app, which then calls the authenticated POST to
  // perform the exchange. That keeps the exchange tied to a real logged-in
  // user instead of to whoever can reach a public URL.
  fastify.get('/v1/capture/email/oauth/callback', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>
    const { code, state, error } = query

    const deepLink =
      code !== undefined && code.length > 0
        ? `fintrack://oauth/google?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state ?? '')}`
        : null

    // A 302 to a custom scheme is unreliable — Chrome on Android blocks
    // scheme redirects that the user did not initiate. So the page tries
    // automatically AND offers a button, which always counts as user-initiated.
    const body =
      error !== undefined
        ? `<h1>Authorization cancelled</h1><p>${escapeHtml(error)}</p><p>You can close this tab and try again.</p>`
        : deepLink === null
          ? `<h1>Missing authorization code</h1><p>Google redirected here without a code. Start the connection again from the app.</p>`
          : `<h1>Gmail connected</h1>
             <p>Returning you to FinTrack&hellip;</p>
             <p><a class="btn" href="${escapeHtml(deepLink)}">Return to FinTrack</a></p>
             <p class="muted">If the app does not open, paste this code into it:</p>
             <code>${escapeHtml(code ?? '')}</code>
             <script>setTimeout(function(){location.href=${JSON.stringify(deepLink)}},400)</script>`

    return reply
      .code(error !== undefined || deepLink === null ? 400 : 200)
      .type('text/html; charset=utf-8')
      // The URL holds a live authorization code — keep it out of every cache.
      .header('Cache-Control', 'no-store')
      .send(page(body))
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
          required: ['code'],
          properties: {
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

      const { code } = parsed.data
      const { email } = await connectGmailUseCase.execute(requireUser(request).sub, code)

      return reply.code(200).send(successEnvelope({ email }, request.requestId))
    },
  )

  // 1b. Is an inbox connected, and which one?
  //
  // Settings needs this and had no cheap way to ask. The only existing signal
  // was the discovery scan, which fetches forty messages and calls a model —
  // half a minute of work to answer a yes/no question, and it would run every
  // time somebody opened a settings screen.
  //
  // The address is returned because it is the one thing a person needs to
  // check: they authorised a mailbox, quite possibly not the one they signed
  // up with, and being told WHICH is what makes disconnecting a safe decision
  // rather than a guess.
  fastify.get(
    '/v1/capture/email/connection',
    {
      preHandler: [authenticate],
      schema: {
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
                required: ['connected'],
                properties: {
                  connected: { type: 'boolean' },
                  emailAddress: { type: 'string', nullable: true },
                  connectedAt: { type: 'string', format: 'date-time', nullable: true },
                },
              },
              requestId: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const connection = await connectionRepo.findByUserId(requireUser(request).sub)
      return reply.code(200).send(
        successEnvelope(
          {
            connected: connection !== null,
            emailAddress: connection?.emailAddress ?? null,
            connectedAt: connection?.connectedAt.toISOString() ?? null,
          },
          request.requestId,
        ),
      )
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
          properties: {},
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

      await disconnectGmailUseCase.execute(requireUser(request).sub)

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

  // ── Account discovery ───────────────────────────────────────────────
  //
  // Two endpoints, and the split between them is the privacy design rather
  // than a REST convention. The scan RETURNS what it found and stores none of
  // it, because a shared or forwarded inbox can surface another person’s name
  // and account number. Only what the user ticks reaches the database.

  fastify.get(
    '/v1/capture/email/discovered-accounts',
    {
      preHandler: [authenticate],
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['success', 'data', 'requestId'],
            properties: {
              success: { type: 'boolean', const: true },
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['bankName'],
                  properties: {
                    bankName: { type: 'string' },
                    accountMask: { type: 'string', nullable: true },
                    holderName: { type: 'string', nullable: true },
                  },
                },
              },
              requestId: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const found = await discoverAccountsUseCase.execute(requireUser(request).sub)
      return reply.code(200).send(successEnvelope(found, request.requestId))
    },
  )

  fastify.post(
    '/v1/capture/email/discovered-accounts/confirm',
    {
      preHandler: [authenticate],
      config: {
        audit: { action: 'confirm_discovered_accounts', resourceType: 'account' },
      },
      schema: {
        body: {
          type: 'object',
          required: ['accounts'],
          additionalProperties: false,
          properties: {
            accounts: {
              type: 'array',
              items: {
                type: 'object',
                required: ['bankName', 'accountType'],
                additionalProperties: false,
                properties: {
                  bankName: { type: 'string', minLength: 1, maxLength: 100 },
                  accountMask: { type: 'string', nullable: true, minLength: 1, maxLength: 64 },
                  holderName: { type: 'string', nullable: true, maxLength: 120 },
                  accountType: { type: 'string', enum: ['CURRENT', 'SAVINGS', 'WALLET'] },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = confirmAccountsBodySchema.safeParse(request.body)
      if (!body.success) {
        const issue = body.error.issues[0]
        throw validationError(issue?.message ?? 'Validation failed', issue?.path[0]?.toString())
      }

      const result = await confirmAccountsUseCase.execute(
        requireUser(request).sub,
        body.data.accounts.map((a) => ({
          bankName: a.bankName,
          accountMask: a.accountMask ?? null,
          holderName: a.holderName ?? null,
          accountType: a.accountType,
        })),
      )

      return reply.code(201).send(successEnvelope(result, request.requestId))
    },
  )
}
