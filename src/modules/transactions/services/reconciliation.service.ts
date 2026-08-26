import type { AppLogger } from '../../../core/logger'

/**
 * Decides whether two records describe THE SAME MONEY.
 *
 * This exists because one payment can reach the ledger by two very different
 * routes: the user types it in from memory, and the bank emails an alert about
 * it. Both are legitimate; only one of them should end up as a row.
 *
 * ── Why hashing was not enough ────────────────────────────────────────────
 * The previous defence hashed account + amount + a 5-minute time BUCKET. That
 * fails in two opposite directions at once:
 *
 *   Bucketing is not proximity. floor(t / 5min) puts 14:59:59 and 15:00:01 in
 *   different buckets — two seconds apart, no match — while 14:00:01 and
 *   14:04:59 collide. A human typing an approximate time straddles a boundary
 *   about as often as not.
 *
 *   The merchant was not in the hash at all. So two genuinely separate payments
 *   of the same amount from the same account in one bucket collapsed into one,
 *   silently DELETING a real transaction.
 *
 * Those two failure modes pull against each other. Loosening the match to catch
 * more duplicates swallows more real payments; tightening it does the reverse.
 * One threshold cannot serve both, which is why this is a decision rather than
 * a hash.
 *
 * ── The shape of the answer ───────────────────────────────────────────────
 * Separate what must be EXACT from what is necessarily FUZZY.
 *
 *   Exact gates, applied by the caller in SQL: same account, same amount to the
 *   kobo, same direction. Money is exact — a near-match on amount is a
 *   different payment. These three cut the candidate set to almost nothing,
 *   which is what makes the fuzzy part affordable.
 *
 *   Fuzzy signals, scored here: time proximity and merchant similarity. The
 *   user types "Shoprite"; the bank says "SHOPRITE IKEJA CITY MALL LAG". The
 *   user says 14:32; the bank says 14:28:07. Neither can be an equality test.
 *
 * ── Why the verdict depends on which way the pair arrived ─────────────────
 * A manual entry is a placeholder for a bank event that has not arrived yet.
 * That asymmetry is the most useful fact available, so the rules key on it.
 * See decide() for the table.
 *
 * ── The rule that keeps recurring payments safe ───────────────────────────
 * Each manual entry absorbs AT MOST ONE automatic capture. Someone who buys the
 * same airtime twice in a day, and typed one of them in, must still end up with
 * two rows. That holds because superseding flips the row's source away from
 * MANUAL, so it stops being a candidate — the second alert finds nothing to
 * absorb and correctly creates its own row. No extra bookkeeping required.
 */

/** A human typing a time is approximate; inside this, treat times as equal. */
const TIGHT_WINDOW_MS = 15 * 60 * 1000

/**
 * The outer edge of "could plausibly be the same payment". Deliberately wide,
 * because people record things hours after the fact — that evening, or the next
 * morning. Beyond it, a match is coincidence rather than a duplicate.
 */
const WIDE_WINDOW_MS = 36 * 60 * 60 * 1000

/** Merchant similarity at or above this reads as "the same counterparty". */
const MERCHANT_MATCH_THRESHOLD = 0.5

export type CaptureSourceName = 'EMAIL' | 'MANUAL' | 'SMS' | 'MONO'

/** True for records the bank produced, false for what a person typed. */
export function isAutomatic(source: CaptureSourceName): boolean {
  return source !== 'MANUAL'
}

export type ReconcileSubject = {
  readonly merchantName: string
  readonly transactionDate: Date
  readonly source: CaptureSourceName
  /**
   * The bank's own id for this payment, where its alert stated one.
   *
   * Used here in ONE direction only: two records carrying DIFFERENT references
   * are different payments, full stop, and that ends the comparison. The
   * reverse — treating equal references as proof of sameness — is deliberately
   * not decided here, because it depends on facts this class cannot see. It is
   * settled at ingest, where a reference can be checked against every row
   * already carrying it. See findByProviderRef.
   */
  readonly reference?: string | undefined
}

export type ReconcileCandidate = ReconcileSubject & {
  readonly id: string
}

export type MatchVerdict =
  /** Nothing in the ledger describes this money. Create the row. */
  | { readonly kind: 'distinct' }
  /**
   * The bank's version of a payment the user already typed in. Replace the
   * placeholder's contents with the authoritative ones, keeping its id.
   */
  | { readonly kind: 'supersedes'; readonly candidate: ReconcileCandidate; readonly reason: string }
  /**
   * This money is already recorded, at least as well as the incoming version
   * would record it. Create nothing.
   */
  | { readonly kind: 'already-recorded'; readonly candidate: ReconcileCandidate; readonly reason: string }
  /**
   * Close enough to be worth a question, not close enough to act on alone.
   * Never resolved by guessing: one way doubles the user's money, the other
   * deletes a payment they really made, and both destroy trust in the ledger.
   */
  | { readonly kind: 'uncertain'; readonly candidate: ReconcileCandidate; readonly reason: string }

export type ReconciliationServiceDeps = {
  readonly logger?: AppLogger
}

/**
 * Splits a merchant string into comparable word tokens. Case and punctuation
 * carry no meaning here, and single characters are noise.
 */
function tokenize(name: string): readonly string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 1)
}

/**
 * How much two merchant strings look like the same counterparty, 0 to 1.
 *
 * Not an edit distance: the realistic difference is not typos but EXTRA WORDS.
 * A bank writes the branch, the city and the terminal into the same field the
 * user filled with a single word. So overlap is measured against the SHORTER
 * side — otherwise "Shoprite" against "SHOPRITE IKEJA CITY MALL LAG" scores
 * one fifth and gets judged a different shop.
 */
export function merchantSimilarity(left: string, right: string): number {
  const a = tokenize(left)
  const b = tokenize(right)
  if (a.length === 0 || b.length === 0) return 0

  const setA = new Set(a)
  const setB = new Set(b)

  let shared = 0
  for (const token of setA) {
    if (setB.has(token)) shared += 1
  }

  const smaller = Math.min(setA.size, setB.size)
  const overlap = shared / smaller
  if (overlap > 0) return overlap

  // No shared whole words. Fall back to containment, which catches the
  // run-together forms banks favour — "QUICKTELLER/DSTV" against "DStv".
  const joinedA = a.join('')
  const joinedB = b.join('')
  const [shorter, longer] = joinedA.length <= joinedB.length ? [joinedA, joinedB] : [joinedB, joinedA]
  if (shorter.length >= 4 && longer.includes(shorter)) return 0.75

  return 0
}

function describeGap(gapMs: number): string {
  const minutes = Math.round(gapMs / 60000)
  if (minutes < 1) return 'at the same moment'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} apart`
  const hours = Math.round(gapMs / 3600000)
  return `${hours} hour${hours === 1 ? '' : 's'} apart`
}

export class ReconciliationService {
  private readonly logger: AppLogger | undefined

  public constructor(deps: ReconciliationServiceDeps = {}) {
    this.logger = deps.logger
  }

  /** The widest gap worth querying for, so callers build the matching window. */
  public static get windowMs(): number {
    return WIDE_WINDOW_MS
  }

  /**
   * Picks the best verdict across all candidates.
   *
   * Every candidate has already passed the exact gates in SQL, so all of them
   * share the account, the amount to the kobo and the direction. What is left
   * is deciding whether the time and the counterparty agree.
   *
   * Two orderings matter. Candidates are considered CLOSEST IN TIME FIRST, so
   * when several could match, the money pairs with its nearest neighbour rather
   * than whichever row the database happened to return first. And a definite
   * answer beats a question: if any candidate clearly is the same money, that
   * settles it and no prompt is raised.
   */
  public reconcile(
    incoming: ReconcileSubject,
    candidates: readonly ReconcileCandidate[],
  ): MatchVerdict {
    let uncertain: MatchVerdict | null = null

    const byProximity = [...candidates].sort(
      (left, right) =>
        Math.abs(incoming.transactionDate.getTime() - left.transactionDate.getTime()) -
        Math.abs(incoming.transactionDate.getTime() - right.transactionDate.getTime()),
    )

    for (const candidate of byProximity) {
      const verdict = this.decide(incoming, candidate)
      if (verdict.kind === 'supersedes' || verdict.kind === 'already-recorded') {
        this.logger?.debug(
          { candidateId: candidate.id, kind: verdict.kind },
          'reconciliation matched an existing transaction',
        )
        return verdict
      }
      if (verdict.kind === 'uncertain' && uncertain === null) {
        uncertain = verdict
      }
    }

    return uncertain ?? { kind: 'distinct' }
  }

  /**
   * The rule table, keyed on which way round the pair arrived.
   *
   *   automatic landing on a manual placeholder → supersedes, across the whole
   *   window, even when the merchant text disagrees.
   *       A manual entry is a claim that a bank event happened on this account.
   *       Matching it to that event is the outcome the user was asking for. The
   *       merchant strings routinely disagree here through no fault of anyone's
   *       — someone types "Fuel" and the bank writes the station's registered
   *       trading name — so demanding they agree would leave the placeholder
   *       standing beside its own bank record, which is the exact duplicate
   *       this class exists to prevent.
   *       What keeps this safe is the three exact gates plus consume-once: a
   *       second real payment of the identical amount finds no placeholder
   *       left and correctly creates its own row.
   *
   *   manual landing on anything already recorded → already-recorded
   *       The ledger already holds this money, and for an automatic row it
   *       holds it better. Adding the typed version would double it. The user
   *       is present for this decision, so a disagreeing merchant becomes a
   *       question rather than an assumption.
   *
   *   automatic landing on automatic → suppressed only when the merchant
   *   agrees AND the times are tight; otherwise raised as a question.
   *       Two alerts for one event is a bank-side artefact. But two genuinely
   *       separate payments sharing an amount is a real Nigerian pattern —
   *       ₦500 of airtime twice in one day — and the old hash, which ignored
   *       the merchant entirely, silently deleted the second one. Requiring
   *       the merchant to agree is what fixes that.
   */
  private decide(incoming: ReconcileSubject, candidate: ReconcileCandidate): MatchVerdict {
    const gapMs = Math.abs(incoming.transactionDate.getTime() - candidate.transactionDate.getTime())
    if (gapMs > WIDE_WINDOW_MS) {
      return { kind: 'distinct' }
    }

    // ── The one place this stops being a judgement call ───────────────────
    // Two bank records that state DIFFERENT references are different payments.
    // Nothing below can outweigh that: the amount, the time and the counterparty
    // may all coincide between two separate payments — ₦500 of airtime twice in
    // a day is the ordinary case — but the bank's own identifier cannot.
    //
    // Only the inequality is trusted here, and only when both sides have one.
    // That is the safe direction: acting on it can at worst leave two rows the
    // user can see, whereas trusting equality could suppress a real payment,
    // and equality deserves the stronger check that ingest applies.
    if (
      incoming.reference !== undefined &&
      candidate.reference !== undefined &&
      incoming.reference !== candidate.reference
    ) {
      return { kind: 'distinct' }
    }

    const similarity = merchantSimilarity(incoming.merchantName, candidate.merchantName)
    const merchantAgrees = similarity >= MERCHANT_MATCH_THRESHOLD
    const nearInTime = gapMs <= TIGHT_WINDOW_MS

    // Inside the tight window, an exact account + amount + direction match is
    // the same event even when the names look nothing alike — a bank's merchant
    // string often bears no resemblance to what a person types, since a card
    // payment can surface under the processor's name rather than the shop's.
    const sameEvent = merchantAgrees || nearInTime

    const incomingIsAuto = isAutomatic(incoming.source)
    const candidateIsAuto = isAutomatic(candidate.source)

    if (incomingIsAuto && !candidateIsAuto) {
      return {
        kind: 'supersedes',
        candidate,
        reason: merchantAgrees
          ? `the bank record for a transaction entered by hand ${describeGap(gapMs)}`
          : `the bank record for a transaction entered by hand ${describeGap(gapMs)}, under a different name`,
      }
    }

    if (!incomingIsAuto) {
      if (!sameEvent) {
        return {
          kind: 'uncertain',
          candidate,
          reason: `an identical amount ${describeGap(gapMs)}, but the merchant does not match`,
        }
      }
      return {
        kind: 'already-recorded',
        candidate,
        reason: candidateIsAuto
          ? `already captured from your bank alert ${describeGap(gapMs)}`
          : `already entered by hand ${describeGap(gapMs)}`,
      }
    }

    // Both sides are bank records.
    if (merchantAgrees && nearInTime) {
      return {
        kind: 'already-recorded',
        candidate,
        reason: `the same bank record arrived twice ${describeGap(gapMs)}`,
      }
    }

    if (!sameEvent) {
      return { kind: 'distinct' }
    }

    return {
      kind: 'uncertain',
      candidate,
      reason: `a second bank record with an identical amount ${describeGap(gapMs)}`,
    }
  }
}

export { TIGHT_WINDOW_MS, WIDE_WINDOW_MS, MERCHANT_MATCH_THRESHOLD }
