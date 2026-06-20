import type { ConnectionOptions, Job } from 'bullmq'
import { BaseWorker } from '../../../core/queue/base-worker'
import { QUEUE_NAMES } from '../../../core/queue/queues'
import type { QueueRegistry } from '../../../core/queue/queues'
import type { IPrivacyRepository } from '../repositories/privacy.repo'
import type { IUserRepository } from '../../auth/repositories/user.repo'
import type { IAccountRepository } from '../../accounts/repositories/account.repo'
import { decryptField, decodeFieldEncryptionKey } from '../../../core/crypto/encryption'
import type { AppLogger } from '../../../core/logger'

export type DeletionJobData = {
  readonly userId: string
}

export type AccountDeletionWorkerDeps = {
  readonly connection: ConnectionOptions
  readonly concurrency: number
  readonly privacyRepo: IPrivacyRepository
  readonly userRepo: IUserRepository
  readonly accountRepo: IAccountRepository
  readonly queues: QueueRegistry
  readonly fieldEncryptionKeyBase64: string
  readonly googleClientId: string | undefined
  readonly googleClientSecret: string | undefined
  readonly logger: AppLogger
}

/**
 * Account Deletion Worker
 *
 * Executes the full NDPR-compliant account deletion cascade:
 * 1. Revoke Gmail OAuth (all connected accounts)
 * 2. Delete all user data in deterministic order
 * 3. Anonymize billing/audit records
 * 4. Dispatch farewell confirmation email
 *
 * Architecture reference: FinTrack_Backend_Architecture.md lines 1574-1610
 */
export class AccountDeletionWorker extends BaseWorker<DeletionJobData, void> {
  public constructor(deps: AccountDeletionWorkerDeps) {
    super({
      queueName: QUEUE_NAMES.privacyDeletion,
      connection: deps.connection,
      concurrency: deps.concurrency,
      logger: deps.logger,
      processor: async (job: Job<DeletionJobData>) => {
        const { userId } = job.data

        deps.logger.info({ userId, jobId: job.id }, 'Starting account deletion')

        // Verify the deletion is still scheduled (user may have cancelled)
        const scheduledAt = await deps.privacyRepo.getDeletionScheduledAt(userId)
        if (scheduledAt === null) {
          deps.logger.info(
            { userId },
            'Account deletion was cancelled by user — skipping'
          )
          return
        }

        // Fetch user record for email (needed for farewell email after deletion)
        const user = await deps.userRepo.findById(userId)
        if (!user) {
          deps.logger.warn({ userId }, 'User not found — may already be deleted')
          return
        }

        const userEmail = user.email

        // ── Step 1: Revoke Gmail OAuth for all connected accounts ──
        await revokeAllGmailTokens(deps, userId)

        // ── Steps 2-11: Execute the cascade deletion ──
        await deps.privacyRepo.executeAccountDeletion(userId, userEmail, deps.logger)

        // ── Step 12: Send deletion confirmation email ──
        await deps.queues.notificationsPush.add(
          'data-deletion-confirmation',
          { userId, email: userEmail },
          { jobId: `deletion-confirm-${userId}` }
        )

        deps.logger.info(
          { userId, email: userEmail },
          'Account deletion completed successfully'
        )
      },
    })
  }
}

/**
 * Revoke Gmail OAuth tokens for all connected accounts belonging to a user.
 * This is Step 1 in the architecture deletion sequence.
 *
 * Best-effort: if revocation fails for a specific account, we log a warning
 * but continue with the rest of the deletion. The user's data is being deleted
 * regardless — we just can't guarantee Google's side is clean.
 */
async function revokeAllGmailTokens(
  deps: Pick<AccountDeletionWorkerDeps, 'accountRepo' | 'fieldEncryptionKeyBase64' | 'googleClientId' | 'googleClientSecret' | 'logger'>,
  userId: string
): Promise<void> {
  const accounts = await deps.accountRepo.findByUserId(userId)
  const connectedAccounts = accounts.filter((a) => a.gmailConnected)

  if (connectedAccounts.length === 0) {
    deps.logger.info({ userId }, 'Step 1: No Gmail-connected accounts — skipping OAuth revocation')
    return
  }

  const encryptionKey = decodeFieldEncryptionKey(deps.fieldEncryptionKeyBase64)

  for (const account of connectedAccounts) {
    try {
      const tokenEnc = await deps.accountRepo.getGmailToken(account.id)
      if (!tokenEnc) {
        continue
      }

      const decrypted = decryptField(tokenEnc, encryptionKey)
      const payload = JSON.parse(decrypted) as {
        readonly refreshToken?: string | null
        readonly accessToken?: string
      }

      const tokenToRevoke = payload.refreshToken ?? payload.accessToken
      if (!tokenToRevoke) {
        deps.logger.warn({ accountId: account.id }, 'No token to revoke for account')
        continue
      }

      const revokeResponse = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: tokenToRevoke }),
      })

      if (revokeResponse.ok) {
        deps.logger.info({ accountId: account.id }, 'Step 1: Gmail OAuth token revoked')
      } else {
        const errorText = await revokeResponse.text()
        deps.logger.warn(
          { accountId: account.id, status: revokeResponse.status, errorText },
          'Step 1: Gmail OAuth revocation returned non-OK status (continuing anyway)'
        )
      }
    } catch (err) {
      deps.logger.warn(
        { accountId: account.id, err },
        'Step 1: Failed to revoke Gmail OAuth token (continuing with deletion)'
      )
    }
  }
}
