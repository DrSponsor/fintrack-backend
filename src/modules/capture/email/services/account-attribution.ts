/**
 * Deciding which account an alert is actually about.
 *
 * ── The bug this exists to fix ───────────────────────────────────────────
 * The ingest worker took the account from its JOB, never from the alert:
 *
 *     const { accountId, messageId } = job.data
 *     transactionRepo.create({ accountId, ... })
 *
 * and the Gmail webhook queues one job per Gmail-connected account. So one
 * notification about one email produced N jobs carrying the same message under
 * N different account ids. Deduplication is global — findByIdempotencyKey
 * filters on the message id alone — so the first worker to finish wrote the
 * row and the rest were discarded as duplicates.
 *
 * The transaction therefore landed on whichever account won a race, not on the
 * account the bank was writing about. One account made that invisible; a
 * second makes it silent corruption, and the account-discovery flow exists
 * precisely to encourage a second.
 *
 * ── Why matching is on trailing digits, not on the whole mask ────────────
 * Banks mask account numbers differently and this system holds exactly one
 * real sample, which was itself replaced during a PII sweep. Writing a matcher
 * against a format nobody has verified is how nine parsers ended up asserting
 * an invented one.
 *
 * So the shape is not assumed. Whatever run of digits the bank leaves visible
 * at the END is compared against the four digits the account was registered
 * with. That works whether a bank reveals three digits or four, and it degrades
 * to "no opinion" rather than to a wrong answer when a bank reveals none.
 *
 * ── Three digits is a weak key, so a tie is never broken ─────────────────
 * Three revealed digits collide once in a thousand, which is remote across one
 * person's handful of accounts but not impossible — and a wrong attribution is
 * invisible once written. So a tie is reported as ambiguous and the caller
 * keeps its existing behaviour. Guessing between two accounts is strictly worse
 * than staying where we already were.
 */

/** Fewest revealed digits worth matching on. Below this the key is too weak
 *  to distinguish accounts and the answer would be close to a coin toss. */
export const MIN_REVEALED_DIGITS = 3

export type Attribution =
  /** Exactly one account matched. */
  | { readonly kind: 'matched'; readonly accountId: string }
  /** More than one account matched. Deliberately not resolved — see header. */
  | { readonly kind: 'ambiguous'; readonly accountIds: readonly string[] }
  /** The alert names an account this user has not registered. This is the
   *  signal the discovery flow is built on, not an error. */
  | { readonly kind: 'unknown' }
  /** The alert stated no usable account number, so this has no opinion and the
   *  caller should do whatever it did before. */
  | { readonly kind: 'no-opinion'; readonly reason: string }

export type AttributableAccount = {
  readonly id: string
  /** Exactly four digits — enforced by createAccountBodySchema. */
  readonly accountLast4: string
}

/**
 * The run of digits a bank leaves visible at the end of a masked number.
 *
 * Returns null when the mask ends in something other than digits, which is the
 * honest answer for a format this function was not built against.
 */
export function revealedTail(mask: string): string | null {
  const match = /(\d+)\s*$/.exec(mask.trim())
  const tail = match?.[1]
  if (tail === undefined || tail.length < MIN_REVEALED_DIGITS) return null
  // A fully unmasked number is not a mask, but it is still a usable key, so
  // only the last four matter — that is all an account stores.
  return tail.length > 4 ? tail.slice(-4) : tail
}

/**
 * Which of this user's accounts the alert is about.
 *
 * `accounts` must already be scoped to one user. Nothing here checks
 * ownership, because a function that silently accepted another person's
 * accounts would be a data leak with a plausible-looking result.
 */
export function attributeByMask(
  mask: string | undefined,
  accounts: readonly AttributableAccount[],
): Attribution {
  if (mask === undefined || mask.trim().length === 0) {
    return { kind: 'no-opinion', reason: 'alert stated no account number' }
  }

  const tail = revealedTail(mask)
  if (tail === null) {
    return {
      kind: 'no-opinion',
      reason: `mask reveals fewer than ${MIN_REVEALED_DIGITS} trailing digits`,
    }
  }

  // endsWith, not equality: the bank may reveal three digits where the account
  // was registered with four.
  const hits = accounts.filter((account) => account.accountLast4.endsWith(tail))

  if (hits.length === 1) {
    const only = hits[0]
    if (only !== undefined) return { kind: 'matched', accountId: only.id }
  }
  if (hits.length > 1) {
    return { kind: 'ambiguous', accountIds: hits.map((account) => account.id) }
  }
  return { kind: 'unknown' }
}
