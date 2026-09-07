import type { OAuthService } from './oauth.service'
import type { FetchService } from './fetch.service'
import type { SafetyFilterService } from './safety-filter.service'
import type { AccountDiscoveryService, DiscoveredAccount } from './account-discovery.service'
import type { IAccountRepository } from '../../../accounts/repositories/account.repo'
import { revealedTail } from './account-attribution'
import { cleanText } from '../parsers/utils'
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

/**
 * What a bank alert looks like to Gmail's own search.
 *
 * Deliberately phrases rather than single words. "credit" alone matches half a
 * personal inbox — credit cards, course credits, closing credits — and every
 * one of those costs a fetch that the local keyword filter then throws away.
 * The sentence a Nigerian bank actually writes is distinctive, and Gmail's
 * search is far better at finding it than fetching forty recent messages and
 * hoping.
 *
 * OR'd rather than AND'd because banks phrase it differently, and a scan that
 * misses one bank is worse than one that fetches a few false positives — the
 * local filter and the model both get another say afterwards.
 */
const ALERT_QUERY = [
  '"has been debited"',
  '"has been credited"',
  '"debit alert"',
  '"credit alert"',
  '"transaction alert"',
  '"transaction notification"',
  '"account statement"',
  'subject:(debit OR credit OR transaction)',
  // Found by WHO SENT IT, not only by what it says.
  //
  // Every clause above guesses at wording. That guess has now been wrong on a
  // real inbox: a person receiving Opay alerts constantly scanned to nothing,
  // and no phrase here is one we have ever confirmed against an actual Opay
  // email — the hand-written Opay parser was deleted precisely because it
  // failed all eleven real ones it was finally tested against.
  //
  // A sender is a fact rather than a guess. Matching loosely on the name means
  // a bank is found even when it phrases its alert in a way nobody predicted,
  // which is the failure mode this scan keeps hitting.
  'from:(opay OR palmpay OR moniepoint OR kuda OR gtbank OR gtb OR accessbank OR zenithbank OR ubagroup OR firstbank OR stanbic OR fidelitybank OR unionbank OR wema OR alat OR sterling OR fcmb OR polaris OR ecobank OR keystone OR providus OR carbon OR fairmoney OR piggyvest OR cowrywise)',
].join(' OR ')

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

        // Read the body ONCE, preferring HTML, and let every gate below judge
        // the same text.
        //
        // `bodyText` is only populated when the message carries a text/plain
        // MIME part. A sender that mails HTML alone — which is most banks, and
        // every styled receipt — arrives with bodyText === ''. That was already
        // known here: the model was given `bodyHtml || bodyText` precisely
        // because Access sends an HTML table whose plain-text part is nearly
        // empty. But the two filters above it still read `bodyText`, so for an
        // HTML-only bank they ran against an empty string and the subject had
        // to carry the decision by itself.
        //
        // Both directions of that were wrong. A real alert whose subject
        // happens not to contain one of the twenty transaction keywords was
        // dropped before the model ever saw it — the scan then reported "no
        // accounts found" on a mailbox full of bank mail, with nothing logged
        // to say an email had been discarded. And in the other direction, an
        // HTML-only one-time-passcode email skipped BODY_DISCARD entirely,
        // which is the check that exists to keep passcodes away from a
        // third-party model.
        const body = cleanText(email.bodyHtml || email.bodyText)

        // The safety gate applies here exactly as it does on ingest. A
        // one-time passcode is not a transaction alert, and it must not reach
        // a third-party model just because the flow it arrived in is new.
        if (this.safetyFilter.shouldDiscard(email.subject, body)) continue
        if (!this.safetyFilter.hasTransactionKeywords(email.subject, body)) {
          // Logged, because the previous silence is what made this take three
          // rounds of debugging on a real inbox: a discarded email and an
          // inbox with no bank mail in it produced identical output.
          this.logger.debug(
            { messageId, senderDomain: email.senderDomain },
            'discovery skipped a message with no transaction keywords',
          )
          continue
        }

        sources.push({
          subject: email.subject,
          body,
          senderDomain: email.senderDomain,
        })
      } catch (err) {
        // One unreadable message must not fail the scan. Discovery is a
        // best-effort inventory, and a partial answer is useful.
        this.logger.warn({ err, messageId }, 'skipping a message during account discovery')
      }
    }

    // Domains only — enough to tell whether real bank mail reached the model,
    // without writing anybody’s correspondence into a log file.
    const domains = [...new Set(sources.map((s) => s.senderDomain))].slice(0, 15)
    this.logger.info(
      { listed: messageIds.length, usable: sources.length, domains },
      'account discovery gathered mail',
    )

    const found = await this.discovery.discover(sources)
    if (found.length === 0) return []

    // The digits each existing account is recognisable by, preferring the
    // bank's own mask over a typed recollection — the same order attribution
    // uses, so anything an incoming alert would already match is never offered
    // to the user as new.
    const existing = await this.accountRepo.findByUserId(userId)
    const known = new Set<string>()
    // Accounts that have no number of their own are recognised by bank and
    // holder instead — the Opay case, where the bank never prints the owner's
    // account number and the only number in the email belongs to whoever they
    // paid. Without this second set, such an account is offered again on every
    // scan, because there is no tail to match it on.
    const knownIdentities = new Set<string>()
    const flatten = (value: string): string => value.toLowerCase().replace(/\s+/g, '')

    for (const account of existing) {
      const tail =
        (account.accountMask !== null ? revealedTail(account.accountMask) : null) ??
        account.accountLast4
      if (tail !== null && tail.length > 0) known.add(tail)
      if (account.holderName !== null && account.holderName.length > 0) {
        knownIdentities.add(`${flatten(account.bankName)}|${flatten(account.holderName)}`)
      }
    }

    const offers = found.filter((candidate) => {
      if (candidate.accountMask === null) {
        // Nothing to match digits on. Offer it unless this person already has
        // an account at that bank in that name.
        if (candidate.holderName === null) return false
        return !knownIdentities.has(
          `${flatten(candidate.bankName)}|${flatten(candidate.holderName)}`,
        )
      }

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
    // Ask Gmail for bank alerts, not for everything recent.
    //
    // This was `after:DATE` alone, which returns the most recent messages of
    // ANY kind. The ingest path uses the same bare query and gets away with it
    // because it PAGES through every result until the window is exhausted;
    // discovery takes the first 40 and stops. In an ordinary inbox those forty
    // are newsletters and app notifications, every one of them dropped by the
    // keyword filter below — so the scan reported "no accounts found" on a
    // mailbox that demonstrably contains bank alerts.
    //
    // Filtering server-side also means the 40 fetches are spent on plausible
    // alerts rather than on mail that will be discarded locally, which is what
    // makes a bounded scan worth doing at all.
    // The OR group is PARENTHESISED. Gmail binds a space (AND) tighter than
    // OR, so `after:D a OR b OR c` means `(after:D AND a) OR b OR c` — the date
    // constrained only the first clause and every other one searched the whole
    // mailbox. That silently spent the 40-message budget on mail of any age.
    url.searchParams.set('q', `after:${yyyy}/${mm}/${dd} (${ALERT_QUERY})`)
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
