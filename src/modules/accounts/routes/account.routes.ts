import type { FastifyInstance } from 'fastify'
import {
  CreateAccountUseCase,
  ListAccountsUseCase,
  GetAccountUseCase,
  UpdateAccountUseCase,
  DeleteAccountUseCase,
} from '../use-cases/account.use-cases'
import { PrismaAccountRepository } from '../repositories/account.repo'
import { authenticate } from '../../../core/middleware/authenticate'
import { successEnvelope } from '../../../core/http/envelope'
import {
  createAccountJsonSchema,
  listAccountsJsonSchema,
  getAccountJsonSchema,
  deleteAccountJsonSchema,
} from '../schemas/account.schemas'

/**
 * Account routes — bank account CRUD.
 *
 * All routes require authentication. Ownership is enforced inside
 * use cases (not middleware) because account operations use the
 * user's ID from the JWT, not a separate ownership loader.
 *
 * This avoids a redundant DB query: the use case already looks up
 * the account and checks ownership in a single operation.
 */
export function registerAccountRoutes(fastify: FastifyInstance<any, any, any, any, any>): void {
  const accountRepo = new PrismaAccountRepository(fastify.db.primary)

  const createAccountUseCase = new CreateAccountUseCase({ accountRepo, logger: fastify.log })
  const listAccountsUseCase = new ListAccountsUseCase({ accountRepo })
  const getAccountUseCase = new GetAccountUseCase({ accountRepo })
  const updateAccountUseCase = new UpdateAccountUseCase({ accountRepo, logger: fastify.log })
  const deleteAccountUseCase = new DeleteAccountUseCase({ accountRepo, logger: fastify.log })

  // ── POST /v1/accounts ──────────────────────────────────────────
  fastify.post('/v1/accounts', {
    schema: createAccountJsonSchema,
    preHandler: [authenticate],
    config: {
      audit: { action: 'create_account', resourceType: 'account' },
    },
  }, async (request, reply) => {
    const account = await createAccountUseCase.execute(
      request.user!.sub,
      request.user!.tier,
      request.body,
    )

    return reply.code(201).send(successEnvelope(account, request.requestId))
  })

  // ── GET /v1/accounts ───────────────────────────────────────────
  fastify.get('/v1/accounts', {
    schema: listAccountsJsonSchema,
    preHandler: [authenticate],
  }, async (request) => {
    const accounts = await listAccountsUseCase.execute(request.user!.sub)
    return successEnvelope(accounts, request.requestId)
  })

  // ── GET /v1/accounts/:id ───────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/v1/accounts/:id', {
    schema: getAccountJsonSchema,
    preHandler: [authenticate],
  }, async (request) => {
    const account = await getAccountUseCase.execute(request.user!.sub, request.params.id)
    return successEnvelope(account, request.requestId)
  })

  // ── PATCH /v1/accounts/:id ─────────────────────────────────────
  fastify.patch<{ Params: { id: string } }>('/v1/accounts/:id', {
    schema: getAccountJsonSchema,
    preHandler: [authenticate],
    config: {
      audit: { action: 'update_account', resourceType: 'account' },
    },
  }, async (request) => {
    const account = await updateAccountUseCase.execute(
      request.user!.sub,
      request.params.id,
      request.body,
    )
    return successEnvelope(account, request.requestId)
  })

  // ── DELETE /v1/accounts/:id ────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/v1/accounts/:id', {
    schema: deleteAccountJsonSchema,
    preHandler: [authenticate],
    config: {
      audit: { action: 'delete_account', resourceType: 'account' },
      financialMutation: true,
    },
  }, async (request) => {
    await deleteAccountUseCase.execute(request.user!.sub, request.params.id)
    return successEnvelope({ message: 'Account deleted' }, request.requestId)
  })
}
