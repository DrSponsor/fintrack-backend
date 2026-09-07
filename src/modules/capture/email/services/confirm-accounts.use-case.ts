import type { PrismaClient } from '../../../../generated/prisma/client'
import { validationError } from '../../../../core/errors/factories'
import { revealedTail } from './account-attribution'
import type { AppLogger } from '../../../../core/logger'

/**
 * Writes the accounts a person ticked, and only those.
 *
 * ── This is the only place discovered data is stored ─────────────────────
 * The scan returns candidates and keeps none of them. A shared or forwarded
 * inbox can surface another person's name and account number, so nothing found
 * is written until the person whose inbox it is says it is theirs.
 *
 * ── What a confirmed account claims, exactly ─────────────────────────────
 * That a bank sent an alert naming it to this person's connected inbox, and
 * the person confirmed it. Not that they legally own it — a forwarded alert or
 * a family mailbox defeats that, and no amount of scanning fixes it. The row
 * records EMAIL_DISCOVERY as its source rather than a `verified` flag, so
 * every later decision can see how much is actually known.
 */

export type ConfirmedAccountInput = {
  readonly bankName: string
  /** Null when the bank never printed the OWNER'S number — see
   *  DiscoveredAccount.accountMask. Such an account is identified by bank and
   *  holder, and receives alerts through attributeByBank. */
  readonly accountMask: string | null
  readonly holderName: string | null
  readonly accountType: 'CURRENT' | 'SAVINGS' | 'WALLET'
}

export type ConfirmAccountsDeps = {
  readonly prisma: PrismaClient
  readonly logger: AppLogger
}

export class ConfirmAccountsUseCase {
  private readonly prisma: PrismaClient
  private readonly logger: AppLogger

  public constructor(deps: ConfirmAccountsDeps) {
    this.prisma = deps.prisma
    this.logger = deps.logger
  }

  public async execute(
    userId: string,
    confirmed: readonly ConfirmedAccountInput[],
  ): Promise<{ readonly created: number; readonly skipped: number }> {
    if (confirmed.length === 0) return { created: 0, skipped: 0 }

    const existing = await this.prisma.account.findMany({
      where: { userId },
      select: { id: true, accountMask: true, accountLast4: true, bankName: true, holderName: true },
    })

    // The digits each existing account can be recognised by, so confirming
    // twice — a double tap, a retried request, a second scan — does not
    // produce a duplicate the user then has to reconcile by hand.
    const known = new Set<string>()
    for (const account of existing) {
      const tail =
        (account.accountMask !== null ? revealedTail(account.accountMask) : null) ??
        account.accountLast4
      if (tail !== null) known.add(tail)
    }

    let created = 0
    let skipped = 0

    // Accounts with no number of their own are deduplicated on bank and holder,
    // since there is no tail to compare.
    const knownIdentities = new Set<string>()
    const flatten = (value: string): string => value.toLowerCase().replace(/s+/g, '')
    for (const account of existing) {
      if (account.holderName != null && account.holderName.length > 0) {
        knownIdentities.add(`${flatten(account.bankName)}|${flatten(account.holderName)}`)
      }
    }

    for (const candidate of confirmed) {
      // A wallet that never states the owner's account number. The account is
      // still worth holding — it is how Opay alerts reach a home — but it is
      // recognised by bank and holder rather than by digits.
      if (candidate.accountMask === null) {
        if (candidate.holderName === null || candidate.holderName.length === 0) {
          throw validationError(
            'An account with no number must state the account holder, or nothing identifies it.',
            'holderName',
          )
        }

        const identity = `${flatten(candidate.bankName)}|${flatten(candidate.holderName)}`
        if (knownIdentities.has(identity)) {
          skipped++
          continue
        }

        await this.prisma.account.create({
          data: {
            userId,
            bankName: candidate.bankName,
            accountMask: null,
            holderName: candidate.holderName,
            accountType: candidate.accountType,
            captureMethod: 'EMAIL',
            verificationSource: 'EMAIL_DISCOVERY',
            verifiedAt: new Date(),
            accountLast4: null,
          },
        })
        knownIdentities.add(identity)
        created++
        continue
      }

      const tail = revealedTail(candidate.accountMask)
      if (tail === null) {
        // A candidate whose mask reveals nothing usable cannot later be matched
        // to an incoming alert, so storing it would create an account that
        // silently receives nothing — the exact failure discovery exists to end.
        throw validationError(
          `Cannot confirm an account whose number reveals too little: ${candidate.accountMask}`,
          'accountMask',
        )
      }

      if ([...known].some((seen) => (seen.length >= tail.length ? seen.endsWith(tail) : tail.endsWith(seen)))) {
        skipped++
        continue
      }

      await this.prisma.account.create({
        data: {
          userId,
          bankName: candidate.bankName,
          accountMask: candidate.accountMask,
          holderName: candidate.holderName,
          accountType: candidate.accountType,
          // The alerts are already arriving; that is how the account was found.
          captureMethod: 'EMAIL',
          verificationSource: 'EMAIL_DISCOVERY',
          verifiedAt: new Date(),
          // Deliberately not derived from the mask. Access reveals three digits
          // and this column holds four, so filling it would mean inventing one.
          accountLast4: tail.length === 4 ? tail : null,
        },
      })
      known.add(tail)
      created++
    }

    this.logger.info({ userId, created, skipped }, 'confirmed discovered accounts')
    return { created, skipped }
  }
}
