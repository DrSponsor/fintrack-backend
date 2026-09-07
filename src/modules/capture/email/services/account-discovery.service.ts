import { accountDiscoveryPrompt } from '../../../../core/ai/prompts'
import {
  redactForDiscovery,
  isPlausibleAccountMask,
  isPlausibleHolderName,
} from '../parsers/pattern-safety'
import { revealedTail } from './account-attribution'
import type { AppLogger } from '../../../../core/logger'

/**
 * Finds the bank accounts in a person's inbox, so they never have to type one.
 *
 * ── The problem this replaces ────────────────────────────────────────────
 * An account is currently created by typing a bank name and four digits into
 * a form. Nothing verifies any of it. A typo produces an account that looks
 * real, receives nothing, and gives no indication of why — and the app has no
 * way to notice, because it never learned what the bank actually says.
 *
 * The answer was already arriving. Every alert states the account it concerns
 * and, usually, who holds it. The app was parsing straight past both.
 *
 * ── Why a model, and not parsers ─────────────────────────────────────────
 * Ten of the eleven hand-written parsers have never been validated against a
 * real email, so extending them would be building on code known not to work.
 * More importantly, discovery is a fundamentally easier problem than parsing:
 * it runs ONCE, over a handful of emails, and a person immediately checks the
 * result.
 *
 * That inverts the cost of error. A wrong regex is cached and mis-states every
 * transaction from that bank forever, invisibly. A wrong discovery is a row
 * nobody ticks.
 *
 * ── This is evidence, not proof ──────────────────────────────────────────
 * A confirmed account means: an alert naming it was delivered to this person's
 * inbox, it states this holder, and the person said it is theirs. That is
 * meaningfully stronger than a typed guess and still short of verification —
 * a forwarded alert or a shared family inbox defeats it, and the account
 * record says so via its verification source rather than claiming more than it
 * knows.
 *
 * ── Nothing here is stored ───────────────────────────────────────────────
 * The service RETURNS candidates. A scan of a shared inbox can surface another
 * person's name and account, and holding third-party banking data nobody
 * confirmed is not something to do in passing. Only what the user ticks is
 * ever written.
 */

/** Emails sampled per scan. Enough to cover several banks and a few months
 *  without turning a first connection into a large model call. */
export const DISCOVERY_SAMPLE_SIZE = 25

export interface DiscoverySource {
  readonly subject: string
  readonly body: string
  readonly senderDomain: string
}

export interface DiscoveredAccount {
  readonly bankName: string
  /**
   * Null when the bank never printed the OWNER'S number.
   *
   * Opay is the case that forced this. Its transfer alert states the owner's
   * name and balance, and the only account number anywhere in the email is the
   * BENEFICIARY'S — the stranger the money was sent to. An account number was
   * previously required, so the one number present was the one returned, and
   * the owner would have been shown somebody else's bank account and asked
   * whether it was theirs.
   *
   * Null is the honest answer for that shape of email. Such an account is
   * identified by bankName and holderName instead.
   */
  readonly accountMask: string | null
  readonly holderName: string | null
}

export interface IDiscoveryAIProvider {
  complete(systemPrompt: string, userPrompt: string): Promise<string | null>
}

export type AccountDiscoveryDeps = {
  readonly aiProvider: IDiscoveryAIProvider
  readonly logger: AppLogger
}

/** A mask reduced to its SHAPE, so a rejection can be logged without writing
 *  somebody's account number into a log file. */
function shapeOf(mask: string): string {
  return mask.replace(/\d/g, 'N').replace(/[a-z]/gi, 'a').slice(0, 40)
}

/** Collapses masks that differ only in spacing or masking glyph, so the same
 *  account written two ways is not offered twice. */
function maskKey(mask: string): string {
  return mask.replace(/[\s\-]/g, '').replace(/[*x•·]/gi, '*').toLowerCase()
}

/** What identifies an account with no number of its own. Deliberately not the
 *  holder name alone: the same person holds accounts at several banks, and two
 *  people can share a name. */
function identityKey(bankName: string, holderName: string): string {
  const flatten = (value: string): string => value.toLowerCase().replace(/\s+/g, '')
  return `${flatten(bankName)}|${flatten(holderName)}`
}

export class AccountDiscoveryService {
  private readonly aiProvider: IDiscoveryAIProvider
  private readonly logger: AppLogger

  public constructor(deps: AccountDiscoveryDeps) {
    this.aiProvider = deps.aiProvider
    this.logger = deps.logger
  }

  public async discover(emails: readonly DiscoverySource[]): Promise<readonly DiscoveredAccount[]> {
    if (emails.length === 0) return []

    const sample = emails.slice(0, DISCOVERY_SAMPLE_SIZE)
    const body = sample
      .map(
        (email, index) =>
          `--- EMAIL ${index + 1} (from ${email.senderDomain}) ---\n` +
          `Subject: ${email.subject}\n` +
          redactForDiscovery(email.body),
      )
      .join('\n\n')

    let raw: string | null
    try {
      raw = await this.aiProvider.complete(accountDiscoveryPrompt, body)
    } catch (err) {
      // Discovery failing is not fatal: the user can still add an account by
      // hand. Returning nothing is honest; throwing would block a connection
      // that otherwise works.
      this.logger.warn({ err }, 'account discovery call failed')
      return []
    }
    if (raw === null) return []

    return this.parse(raw)
  }

  /**
   * Reads the model's answer, discarding anything it cannot stand behind.
   *
   * Every field is re-checked here rather than trusted. The model is being
   * asked to copy values out of a document, and the failure that matters is a
   * plausible invention — an account number that looks right and is not. The
   * user cannot catch that, because they do not know their own masked number
   * by heart.
   */
  private parse(raw: string): readonly DiscoveredAccount[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      this.logger.warn('account discovery returned unparseable JSON')
      return []
    }

    const list = (parsed as { accounts?: unknown })?.accounts
    if (!Array.isArray(list)) return []

    const seen = new Set<string>()
    const out: DiscoveredAccount[] = []

    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as Record<string, unknown>

      const bankName = typeof row.bankName === 'string' ? row.bankName.trim() : ''
      const accountMask = typeof row.accountMask === 'string' ? row.accountMask.trim() : ''
      const holderRaw = typeof row.holderName === 'string' ? row.holderName.trim() : ''

      // Every rejection says WHY. A silent drop here is indistinguishable
      // from the model finding nothing, and the two need completely different
      // fixes — which cost a debugging session to learn.
      const reject = (reason: string): void => {
        this.logger.warn(
          { reason, bankName, maskShape: shapeOf(accountMask) },
          'account discovery candidate rejected',
        )
      }

      if (bankName.length === 0 || bankName.length > 60) {
        reject(bankName.length === 0 ? 'no bank name' : 'bank name too long')
        continue
      }
      // A number was offered: it still has to survive every check it always
      // did. A number was NOT offered: that is now legitimate, and the holder
      // name has to carry the identification instead.
      const holderName = isPlausibleHolderName(holderRaw) ? holderRaw : null

      if (accountMask.length === 0) {
        if (holderName === null) {
          reject('no account number and no usable holder name — identifies nobody')
          continue
        }

        const identity = identityKey(bankName, holderName)
        if (seen.has(identity)) continue
        seen.add(identity)

        out.push({ bankName, accountMask: null, holderName })
        continue
      }

      if (!isPlausibleAccountMask(accountMask)) {
        reject('mask is not plausible')
        continue
      }
      // A mask is only worth keeping if it still identifies something. This
      // used to reject any '#' at all, on the theory that a '#' meant the
      // model was handing our own redaction back — true when redaction blanked
      // the whole number, and wrong now that it keeps the last three digits.
      // Under the old rule every bank that prints account numbers in full was
      // discovered and then silently dropped.
      //
      // The honest test is not which glyph appears but whether any digits
      // survived, which is exactly what the attribution matcher will later
      // need to recognise this account by.
      if (revealedTail(accountMask) === null) {
        reject('mask reveals no digits to identify an account by')
        continue
      }

      const key = maskKey(accountMask)
      if (seen.has(key)) continue
      seen.add(key)

      out.push({ bankName, accountMask, holderName })
    }

    this.logger.info({ found: out.length, offered: list.length }, 'account discovery completed')
    return out
  }
}
