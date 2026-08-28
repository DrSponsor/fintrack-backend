import { randomUUID } from 'node:crypto'
import type { AppLogger } from '../../../core/logger'

/**
 * Links the two sides of money moved between a user's own accounts.
 *
 * ── The problem ──────────────────────────────────────────────────────────
 * Move ₦50,000 from Access to Opay and two alerts arrive: a debit from one
 * bank and a credit from the other. Both are real, and both are true from
 * their own bank's point of view. But the user's position did not change —
 * they have exactly as much money as before — and recording it as ₦50,000 of
 * SPENDING plus ₦50,000 of INCOME corrupts every figure built on those
 * totals: the month's in and out, the category breakdown, and the projection
 * the dashboard leads with.
 *
 * ── Why both rows are kept ───────────────────────────────────────────────
 * Deleting one would be the obvious fix and it is wrong. Each row is a
 * genuine record from a bank, each carries its own reference and balance, and
 * the user's own statement will show both. An app that silently drops one of
 * them disagrees with the bank, which is the last thing a ledger should do.
 *
 * So both rows stay and are LINKED. Aggregates skip anything carrying a
 * transfer group; the ledger still shows both, labelled as what they are.
 *
 * ── The window is tight on purpose ───────────────────────────────────────
 * This is the whole risk of the feature, so it is worth stating plainly.
 *
 * The failure mode is a false positive: a user pays a shop ₦5,000 from one
 * account and is paid ₦5,000 by a friend into another. Match those and BOTH
 * disappear from the totals — a real expense and a real income, hidden. That
 * is worse than the double-count it was meant to fix, because a wrong figure
 * is at least visible while a missing one is not.
 *
 * Round amounts are common, so the amount alone cannot carry this. What
 * makes a self-transfer distinctive is that it is INSTANT: Nigerian transfers
 * settle over NIP in seconds, and both alerts are sent immediately. Two
 * unrelated payments happening to share an amount AND landing within a few
 * minutes of each other on two accounts owned by one person is a genuinely
 * rare coincidence, where the same thing over an hour is not.
 *
 * Hence fifteen minutes rather than the reconciliation engine's thirty-six
 * hours. That window deliberately misses a transfer whose alert was delayed;
 * missing one is a visible, correctable ₦50,000 in the wrong column, while a
 * false match is invisible.
 *
 * ── What is deliberately NOT used ────────────────────────────────────────
 * Merchant names look like the obvious extra signal — "TRF TO OPAY" naming
 * the receiving bank. They are not used, because the one real sample of this
 * format available here reads `MOBILE TRF TO PAY/ /<recipient name>`, which
 * names the person and not the institution. Building a matching rule on a
 * pattern guessed from one example is how the hand-written parsers ended up
 * unusable. If real self-transfer alerts later show a reliable marker, it
 * belongs here as a booster — never as a replacement for the time window.
 */

/** How far apart the two sides of one transfer may be. See the header. */
export const TRANSFER_WINDOW_MS = 15 * 60 * 1000

export type TransferCandidate = {
  readonly id: string
  readonly accountId: string
  readonly transactionDate: Date
  readonly transferGroupId: string | null
}

export type TransferSubject = {
  readonly id: string
  readonly userId: string
  readonly accountId: string
  readonly amountKobo: bigint
  readonly type: 'DEBIT' | 'CREDIT'
  readonly transactionDate: Date
}

export interface ITransferRepository {
  /**
   * Rows on the user's OTHER accounts with the exact same amount, the opposite
   * direction, inside the window. Ordered by nothing in particular — the
   * service picks.
   */
  findCounterparts(subject: TransferSubject, windowMs: number): Promise<readonly TransferCandidate[]>
  /** Writes the same group id onto both rows. */
  linkAsTransfer(
    a: { readonly id: string; readonly transactionDate: Date },
    b: { readonly id: string; readonly transactionDate: Date },
    groupId: string,
  ): Promise<void>
}

export type TransferMatcherDeps = {
  readonly repo: ITransferRepository
  readonly logger: AppLogger
}

export type TransferOutcome =
  | { readonly linked: true; readonly groupId: string; readonly counterpartId: string }
  | { readonly linked: false; readonly reason: string }

export class TransferMatcherService {
  private readonly repo: ITransferRepository
  private readonly logger: AppLogger

  public constructor(deps: TransferMatcherDeps) {
    this.repo = deps.repo
    this.logger = deps.logger
  }

  /**
   * Called once a transaction has been recorded.
   *
   * Runs on BOTH sides, because the two alerts arrive in an order nobody
   * controls — the credit can easily land first. Whichever arrives second
   * finds the first and links the pair, so the logic does not depend on the
   * debit being seen before the credit.
   */
  public async evaluate(subject: TransferSubject): Promise<TransferOutcome> {
    const candidates = await this.repo.findCounterparts(subject, TRANSFER_WINDOW_MS)
    if (candidates.length === 0) {
      return { linked: false, reason: 'no counterpart on another account' }
    }

    const free = candidates.filter(
      (candidate) =>
        // A row already in a group has been claimed by an earlier match.
        // Linking it again would silently move it between groups and leave its
        // original partner alone in a group of one.
        candidate.transferGroupId === null &&
        // Belt and braces against the query. The SQL excludes both of these,
        // but a row linked to itself, or to another row on the same account,
        // would hide a genuine transaction from every total on the dashboard —
        // and it would do so silently. Cheap to check here, expensive to miss.
        candidate.id !== subject.id &&
        candidate.accountId !== subject.accountId,
    )
    if (free.length === 0) {
      return { linked: false, reason: 'every counterpart is already part of a transfer' }
    }

    // Closest in time. With more than one candidate the nearest is the better
    // guess, and picking arbitrarily would make the outcome depend on row
    // order — which is not something a user could ever predict or explain.
    const nearest = free.reduce((best, candidate) => {
      const gap = Math.abs(candidate.transactionDate.getTime() - subject.transactionDate.getTime())
      const bestGap = Math.abs(best.transactionDate.getTime() - subject.transactionDate.getTime())
      return gap < bestGap ? candidate : best
    })

    const groupId = randomUUID()
    await this.repo.linkAsTransfer(
      { id: subject.id, transactionDate: subject.transactionDate },
      { id: nearest.id, transactionDate: nearest.transactionDate },
      groupId,
    )

    this.logger.info(
      {
        groupId,
        userId: subject.userId,
        from: subject.type === 'DEBIT' ? subject.accountId : nearest.accountId,
        to: subject.type === 'DEBIT' ? nearest.accountId : subject.accountId,
        amountKobo: String(subject.amountKobo),
      },
      'Linked two alerts as one transfer between the user’s own accounts',
    )

    return { linked: true, groupId, counterpartId: nearest.id }
  }
}
