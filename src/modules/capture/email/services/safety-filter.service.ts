/**
 * Decides whether an email is a transaction alert worth parsing, or a security
 * email that must never be stored.
 *
 * ── Two bugs this replaces, both silent ──────────────────────────────────
 *
 * 1. SUBSTRING MATCHING. The keywords were tested with `String.includes`, so
 *    'otp', '2fa' and 'mfa' matched anywhere in the text — including inside the
 *    hex and base64 that fills tracking URLs in HTML mail. A pixel at
 *    `/px/a2fa9c1b` contains '2fa', so the email was classified as a two-factor
 *    notice and dropped.
 *
 * 2. SCANNING THE BODY FOR 'otp'. Nigerian bank alerts almost universally
 *    close with a security footer — "Access Bank will never ask you to disclose
 *    your PIN, password or OTP to anyone." That single word disqualified the
 *    email. The filter was therefore most likely to discard precisely the mail
 *    it exists to capture, and it did so without logging anything alarming: the
 *    line reads "discarded by safety gate", which looks like the system working.
 *
 * Both failure modes are invisible from the outside. Nothing errors, nothing
 * retries — transactions simply never appear, and the log looks healthy.
 *
 * ── The rule now ─────────────────────────────────────────────────────────
 * A security email announces itself in the SUBJECT: "Your OTP is 123456",
 * "New login to your account". A transaction alert does not. So single-word
 * tokens are matched against the subject only, on word boundaries.
 *
 * The body is still checked, but only for unambiguous multi-word phrases that
 * a transaction alert would never contain in passing. "verification code" is
 * one; "otp" is not, because a bank alert mentions it every single time while
 * telling you to protect it.
 */

/** Announced in the subject line of a genuine security email. Word-boundary
 *  matched, so `2fa` cannot match inside `a2fa9c1b`. */
const SUBJECT_DISCARD = [
  'otp',
  '2fa',
  'mfa',
  'one-time password',
  'one time password',
  'verification code',
  'reset your password',
  'password reset',
  'login alert',
  'new login',
  'sign-in alert',
  'security alert',
  'two-factor authentication',
] as const

/**
 * Safe to match anywhere in the body: multi-word, and meaningless in a
 * transaction alert. Deliberately does NOT include the bare word 'otp' — see
 * the header note about bank security footers.
 */
const BODY_DISCARD = [
  'one-time password',
  'one time password',
  'verification code',
  'reset your password',
  'two-factor authentication',
] as const

const TRANSACTION_KEYWORDS = [
  'debit',
  'credit',
  'payment',
  'alert',
  'received',
  'transaction',
  'transfer',
  'amount',
  'val',
  'bal',
  '₦',
  'ngn',
  'receipt',
  'spent',
  'purchase',
  'charge',
  'successful',
  'declined',
  'failed',
  'reversed',
] as const

/** Escapes regex metacharacters so a keyword is matched literally. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Builds a word-boundary matcher for a keyword list.
 *
 * `\b` is used only where the keyword starts/ends with a word character — '₦'
 * is not one, and `\b₦` would never match.
 */
function buildMatcher(keywords: readonly string[]): RegExp {
  const parts = keywords.map((keyword) => {
    const escaped = escapeRegex(keyword)
    const lead = /^\w/.test(keyword) ? '\\b' : ''
    const tail = /\w$/.test(keyword) ? '\\b' : ''
    return `${lead}${escaped}${tail}`
  })
  return new RegExp(`(${parts.join('|')})`, 'i')
}

const SUBJECT_DISCARD_RE = buildMatcher(SUBJECT_DISCARD)
const BODY_DISCARD_RE = buildMatcher(BODY_DISCARD)
const TRANSACTION_RE = buildMatcher(TRANSACTION_KEYWORDS)

export class SafetyFilterService {
  /**
   * True if this is a security email that must be discarded without storing.
   *
   * The subject carries the single-word tokens; the body is consulted only for
   * phrases that cannot appear innocently.
   */
  public shouldDiscard(subject: string, bodyText = ''): boolean {
    if (SUBJECT_DISCARD_RE.test(subject)) {
      return true
    }
    return BODY_DISCARD_RE.test(bodyText)
  }

  /** True if the email plausibly contains transaction data. */
  public hasTransactionKeywords(subject: string, bodyText = ''): boolean {
    return TRANSACTION_RE.test(`${subject} ${bodyText}`)
  }
}
