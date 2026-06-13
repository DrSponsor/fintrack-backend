import type { AppLogger } from '../../../core/logger'
import type { IAccountRepository, AccountRecord } from '../repositories/account.repo'
import type { Tier } from '../../../types/auth'
import { notFound, validationError, forbidden } from '../../../core/errors/factories'
import { createAccountBodySchema, updateAccountBodySchema } from '../schemas/account.schemas'

// ──────────────────────────────────────────────────────────────────
// Tier-based account limits
// ──────────────────────────────────────────────────────────────────

const ACCOUNT_LIMITS: Readonly<Record<Tier, number>> = {
  FREE: 3,
  PRO: 20,
}

// ──────────────────────────────────────────────────────────────────
// Use cases
// ──────────────────────────────────────────────────────────────────

export type AccountUseCaseDeps = {
  readonly accountRepo: IAccountRepository
  readonly logger: AppLogger
}

/**
 * Create a bank account.
 *
 * Enforces tier-based limits:
 *   - FREE: max 3 accounts
 *   - PRO: max 20 accounts
 *
 * The limit check + create is NOT a TOCTOU concern here because:
 *   1. A single user cannot create accounts concurrently (UI constraint)
 *   2. Even if they did, worst case they get 4 accounts on FREE —
 *      the next request would fail. No financial impact.
 */
export class CreateAccountUseCase {
  private readonly accountRepo: IAccountRepository
  private readonly logger: AppLogger

  public constructor(deps: AccountUseCaseDeps) {
    this.accountRepo = deps.accountRepo
    this.logger = deps.logger
  }

  public async execute(userId: string, tier: Tier, rawBody: unknown): Promise<AccountRecord> {
    const parsed = createAccountBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      throw validationError(
        firstIssue?.message ?? 'Validation failed',
        firstIssue?.path[0] !== undefined ? String(firstIssue.path[0]) : undefined,
      )
    }

    // Enforce tier-based account limit
    const currentCount = await this.accountRepo.countByUserId(userId)
    const limit = ACCOUNT_LIMITS[tier]
    if (currentCount >= limit) {
      throw forbidden(
        `Account limit reached (${limit}). ${tier === 'FREE' ? 'Upgrade to Pro for more accounts.' : 'Maximum accounts reached.'}`,
      )
    }

    const account = await this.accountRepo.create({
      userId,
      bankName: parsed.data.bankName,
      accountLast4: parsed.data.accountLast4,
      accountType: parsed.data.accountType,
      captureMethod: parsed.data.captureMethod,
    })

    this.logger.info({ userId, accountId: account.id }, 'account created')
    return account
  }
}

/**
 * List all accounts for a user.
 * Ownership-scoped — only returns the requesting user's accounts.
 */
export class ListAccountsUseCase {
  private readonly accountRepo: IAccountRepository

  public constructor(deps: Pick<AccountUseCaseDeps, 'accountRepo'>) {
    this.accountRepo = deps.accountRepo
  }

  public async execute(userId: string): Promise<readonly AccountRecord[]> {
    return this.accountRepo.findByUserId(userId)
  }
}

/**
 * Get a single account by ID.
 *
 * Returns 404 if account doesn't exist OR belongs to another user.
 * Architecture mandate: never return 403 for ownership violations —
 * that confirms the resource exists.
 */
export class GetAccountUseCase {
  private readonly accountRepo: IAccountRepository

  public constructor(deps: Pick<AccountUseCaseDeps, 'accountRepo'>) {
    this.accountRepo = deps.accountRepo
  }

  public async execute(userId: string, accountId: string): Promise<AccountRecord> {
    const account = await this.accountRepo.findById(accountId)
    if (account === null || account.userId !== userId) {
      throw notFound('Account not found')
    }
    return account
  }
}

/**
 * Update an account.
 */
export class UpdateAccountUseCase {
  private readonly accountRepo: IAccountRepository
  private readonly logger: AppLogger

  public constructor(deps: AccountUseCaseDeps) {
    this.accountRepo = deps.accountRepo
    this.logger = deps.logger
  }

  public async execute(userId: string, accountId: string, rawBody: unknown): Promise<AccountRecord> {
    const parsed = updateAccountBodySchema.safeParse(rawBody)
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      throw validationError(
        firstIssue?.message ?? 'Validation failed',
        firstIssue?.path[0] !== undefined ? String(firstIssue.path[0]) : undefined,
      )
    }

    // Ownership check (returns 404 not 403)
    const existing = await this.accountRepo.findById(accountId)
    if (existing === null || existing.userId !== userId) {
      throw notFound('Account not found')
    }

    const updated = await this.accountRepo.update(accountId, parsed.data)
    this.logger.info({ userId, accountId }, 'account updated')
    return updated
  }
}

/**
 * Delete an account.
 *
 * Cascade in Prisma schema handles transaction cleanup.
 */
export class DeleteAccountUseCase {
  private readonly accountRepo: IAccountRepository
  private readonly logger: AppLogger

  public constructor(deps: AccountUseCaseDeps) {
    this.accountRepo = deps.accountRepo
    this.logger = deps.logger
  }

  public async execute(userId: string, accountId: string): Promise<void> {
    const existing = await this.accountRepo.findById(accountId)
    if (existing === null || existing.userId !== userId) {
      throw notFound('Account not found')
    }

    await this.accountRepo.delete(accountId)
    this.logger.info({ userId, accountId }, 'account deleted')
  }
}
