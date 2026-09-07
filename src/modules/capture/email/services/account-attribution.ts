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
  /**
   * The masked number as the bank prints it, when the account was discovered
   * from an alert rather than typed. Preferred over `accountLast4`: it is the
   * bank's own statement, and it is the same string the incoming alert
   * carries, so the two agree by construction.
   */
  readonly accountMask?: string | null
  /** The four digits the user typed, when they typed any. */
  readonly accountLast4?: string | null
  /** The bank as the account records it — "Opay", "Access Bank". Used only by
   *  `attributeByBank`, for accounts that have no digits to match on. */
  readonly bankName?: string | null
}

/**
 * Which account an alert is about when the alert names no account at all.
 *
 * ── Why this is needed ───────────────────────────────────────────────────
 * Some wallets never print the owner's own account number. Opay's transfer
 * alert states the owner's name and their balance, and the only account number
 * in the whole email belongs to the person they PAID. So an Opay account is
 * held with no digits of its own, and `attributeByMask` can only ever answer
 * 'no-opinion' for it.
 *
 * The worker's existing fallback — "no opinion, and the user has exactly one
 * account, so it must be that one" — covers a person with a single account and
 * silently stops working the moment they add a second. Every Opay alert would
 * then be dropped as unplaceable, which is the correct behaviour for an
 * ambiguous alert and the wrong outcome for one that is not actually
 * ambiguous: the sending domain says which bank it came from.
 *
 * ── Why the match is deliberately conservative ───────────────────────────
 * Comparing a bank NAME to a sender DOMAIN is a heuristic, not a fact.
 * "Opay" sits inside "opay-nigeria.com" and "GTBank" inside "gtbank.com", but
 * "United Bank for Africa" is nowhere inside "ubagroup.com". So this answers
 * for the banks it can and refuses for the rest, and refusing simply leaves
 * the caller where it already was.
 *
 * Exactly one account must match. Two accounts at the same bank cannot be told
 * apart by the bank's name, and guessing between them is precisely the silent
 * misfiling this whole module exists to prevent.
 */
export function attributeByBank(
  senderDomain: string,
  accounts: readonly AttributableAccount[],
): Attribution {
  const domain = senderDomain.trim().toLowerCase()
  if (domain.length === 0) {
    return { kind: 'no-opinion', reason: 'the alert carried no sender domain' }
  }

  // The domain reduced to its letters, so "opay-nigeria.com" becomes
  // "opaynigeriacom" and a bank name flattened the same way can be looked for
  // inside it.
  const haystack = domain.replace(/[^a-z]/g, '')

  const matches = accounts.filter((account) => {
    const name = account.bankName?.toLowerCase().replace(/[^a-z]/g, '') ?? ''
    // Three letters is the shortest bank name worth matching on. Below that a
    // substring test starts finding banks inside unrelated words.
    if (name.length < 3) return false
    return haystack.includes(name)
  })

  const only = matches[0]
  if (only === undefined) {
    return { kind: 'no-opinion', reason: 'no account is held at the bank that sent this alert' }
  }
  if (matches.length > 1) {
    return { kind: 'ambiguous', accountIds: matches.map((account) => account.id) }
  }
  return { kind: 'matched', accountId: only.id }
}

/** The digits an account can be recognised by, whichever way it was created. */
function accountTail(account: AttributableAccount): string | null {
  if (account.accountMask != null) {
    const fromMask = revealedTail(account.accountMask)
    if (fromMask !== null) return fromMask
  }
  const typed = account.accountLast4
  return typed != null && typed.length >= MIN_REVEALED_DIGITS ? typed : null
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

  // endsWith in whichever direction has more digits, because the two sides can
  // legitimately differ in length: the bank may reveal three where the user
  // typed four, and vice versa.
  const hits = accounts.filter((account) => {
    const own = accountTail(account)
    if (own === null) return false
    return own.length >= tail.length ? own.endsWith(tail) : tail.endsWith(own)
  })

  if (hits.length === 1) {
    const only = hits[0]
    if (only !== undefined) return { kind: 'matched', accountId: only.id }
  }
  if (hits.length > 1) {
    return { kind: 'ambiguous', accountIds: hits.map((account) => account.id) }
  }
  return { kind: 'unknown' }
}
