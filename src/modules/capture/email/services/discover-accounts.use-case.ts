import type { OAuthService } from './oauth.service'
import type { FetchService } from './fetch.service'
import type { SafetyFilterService } from './safety-filter.service'
import type { AccountDiscoveryService, DiscoveredAccount } from './account-discovery.service'
import type { IAccountRepository } from '../../../accounts/repositories/account.repo'
import { revealedTail } from './account-attribution'
import type { AppLogger } from '../../../../core/logger'

/**
 * Reads a connected inbox and reports the bank accounts in it.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * Adding an account meant typing a bank name and four digits that nothing
 * checked. A typo produced an account that looked real, received nothing, and
 * explained nothing. Meanwhile every alert the app already reads states the
 * account it concerns and, usually, who holds it.
 *
 * So the user stops typing and starts confirming: the app shows what the bank
 * itself printed, and the person ticks which are theirs.
 *
 * ── Nothing is written here ──────────────────────────────────────────────
 * This returns candidates. A shared or forwarded inbox can surface another
 * person's name and account number, and storing third-party banking data that
 * nobody confirmed is not a thing to do in passing. Only what the user
 * explicitly confirms is written, by ConfirmAccountsUseCase.
 *
 * ── Only unregistered accounts are offered ───────────────────────────────
 * An account the user already has is not a discovery. It is filtered on the
 * digits the mask reveals, using the same comparison that attributes an
 * incoming alert — so if attribution would recognise it, discovery will not
 * offer it again.
 */

/** How many recent messages to sample. The scan is a one-off at connect time
 *  and a person reviews the result immediately, so breadth matters more than
 *  depth: enough to cover several banks, not enough to make connecting slow. */
const SCAN_LOOKBACK_DAYS = 120
const SCAN_MAX_MESSAGES = 40

export type DiscoverAccountsDeps = {
  readonly oauthService: OAuthService
  readonly fetchService: FetchService
  readonly safetyFilter: SafetyFilterService
  readonly discovery: AccountDiscoveryService
  readonly accountRepo: IAccountRepository
  readonly logger: AppLogger
}

export class DiscoverAccountsUseCase {
  private readonly oauthService: OAuthService
  private readonly fetchService: FetchService
  private readonly safetyFilter: SafetyFilterService
  private readonly discovery: AccountDiscoveryService
  private readonly accountRepo: IAccountRepository
  private readonly logger: AppLogger

  public constructor(deps: DiscoverAccountsDeps) {
    this.oauthService = deps.oauthService
    this.fetchService = deps.fetchService
    this.safetyFilter = deps.safetyFilter
    this.discovery = deps.discovery
    this.accountRepo = deps.accountRepo
    this.logger = deps.logger
  }

  public async execute(userId: string): Promise<readonly DiscoveredAccount[]> {
    const accessToken = await this.oauthService.getValidAccessToken(userId)

    const messageIds = await this.listRecentMessageIds(accessToken)
    if (messageIds.length === 0) return []

    // Fetched in sequence rather than in parallel. This runs while a person
    // waits on a screen, but Gmail rate-limits hard and a burst of forty
    // concurrent fetches is the reliable way to be throttled — which would
    // turn a slow scan into a failed one.
    const sources: { subject: string; body: string; senderDomain: string }[] = []
    for (const messageId of messageIds) {
      try {
        const email = await this.fetchService.fetchEmailWithBackoff(messageId, accessToken)

        // The safety gate applies here exactly as it does on ingest. A
        // one-time passcode is not a transaction alert, and it must not reach
        // a third-party model just because the flow it arrived in is new.
        if (this.safetyFilter.shouldDiscard(email.subject, email.bodyText)) continue
        if (!this.safetyFilter.hasTransactionKeywords(email.subject, email.bodyText)) continue

        sources.push({
          subject: email.subject,
          body: email.bodyText,
          senderDomain: email.senderDomain,
        })
      } catch (err) {
        // One unreadable message must not fail the scan. Discovery is a
        // best-effort inventory, and a partial answer is useful.
        this.logger.warn({ err, messageId }, 'skipping a message during account discovery')
      }
    }

    const found = await this.discovery.discover(sources)
    if (found.length === 0) return []

    // The digits each existing account is recognisable by, preferring the
    // bank's own mask over a typed recollection — the same order attribution
    // uses, so anything an incoming alert would already match is never offered
    // to the user as new.
    const existing = await this.accountRepo.findByUserId(userId)
    const known = new Set<string>()
    for (const account of existing) {
      const tail =
        (account.accountMask !== null ? revealedTail(account.accountMask) : null) ??
        account.accountLast4
      if (tail !== null && tail.length > 0) known.add(tail)
    }

    const offers = found.filter((candidate) => {
      const tail = revealedTail(candidate.accountMask)
      if (tail === null) return true
      return ![...known].some((seen) =>
        seen.length >= tail.length ? seen.endsWith(tail) : tail.endsWith(seen),
      )
    })

    this.logger.info(
      { userId, scanned: sources.length, found: found.length, offered: offers.length },
      'account discovery complete',
    )
    return offers
  }

  /** Recent message ids, newest first, bounded. */
  private async listRecentMessageIds(accessToken: string): Promise<readonly string[]> {
    const since = new Date(Date.now() - SCAN_LOOKBACK_DAYS * 24 * 3600_000)
    const yyyy = since.getFullYear()
    const mm = String(since.getMonth() + 1).padStart(2, '0')
    const dd = String(since.getDate()).padStart(2, '0')

    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
    url.searchParams.set('q', `after:${yyyy}/${mm}/${dd}`)
    url.searchParams.set('maxResults', String(SCAN_MAX_MESSAGES))

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      this.logger.warn({ status: response.status }, 'Gmail message list failed during discovery')
      return []
    }

    const json = (await response.json()) as { messages?: { id?: string }[] }
    return (json.messages ?? [])
      .map((message) => message.id)
      .filter((id): id is string => typeof id === 'string')
  }
}
