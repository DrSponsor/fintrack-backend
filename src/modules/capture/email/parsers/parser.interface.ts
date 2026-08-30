export interface ParsedTransaction {
  readonly amountKobo: bigint
  readonly type: 'DEBIT' | 'CREDIT'
  readonly merchantName: string
  readonly transactionDate: Date
  readonly balanceAfterKobo?: bigint | undefined
  /**
   * The bank's own identifier for this transaction, when the alert states one.
   *
   * Optional because not every bank prints one and not every parser can find
   * it — but where it exists it is the only field that can settle whether two
   * alerts describe the same payment by EQUALITY rather than by judgement.
   * Everything else (amount, time, counterparty) can legitimately coincide
   * between two separate payments; a reference cannot.
   *
   * Must satisfy isPlausibleReference before it is stored. A mis-captured
   * reference is worse than none: a constant lifted out of the bank's template
   * would be shared by every transaction from that bank, and payments would
   * start collapsing into each other.
   */
  readonly reference?: string | undefined
  /**
   * The account number exactly as the bank masks it — "012******345".
   *
   * This is what lets an alert be attributed to an account the app already
   * knows, instead of trusting the four digits somebody typed into a form. It
   * is also how an account gets DISCOVERED in the first place: an alert naming
   * an account the user has not registered is the app noticing a bank account
   * before the user has told it about one.
   *
   * Stored masked, never reconstructed. The bank chose how much to reveal and
   * there is no reason for this app to hold more than the bank prints.
   */
  readonly accountMask?: string | undefined
  /**
   * The account holder, as the bank states it.
   *
   * Weak evidence on its own — a name in an email proves nothing — but it is
   * the only field that says WHOSE account an alert describes, which is what
   * makes a discovered account reviewable by the person confirming it.
   *
   * Treated as third-party personal data until the user confirms the account
   * is theirs: shown to them, and never persisted before they say so.
   */
  readonly accountHolder?: string | undefined
}

export interface IEmailParser {
  readonly parserId: string
  readonly bankName: string
  readonly supportedDomains: readonly string[]
  /**
   * Whether this parser has been checked against mail a bank actually sent.
   *
   * ── Why this is a field and not a comment ────────────────────────────────
   * A hand-written parse used to be trusted simply because it returned
   * something: `isVerified = parsedTx !== null`. That gave any registered
   * parser the highest trust level in the system on no evidence at all, which
   * is backwards — the AI path, which is trusted LESS, is the one that
   * round-trip verifies every field and sanity-checks magnitudes, directions
   * and dates before believing itself.
   *
   * It was not hypothetical. Nine parsers were written against an invented
   * format (`Amt: NGN 5,000.00 Cr; Desc: ...`) and each had a fixture asserting
   * that same invented format, so they passed CI indefinitely. The one member
   * of that family that ever met real mail — Access — failed all 41 alerts in
   * a live mailbox, having been green the whole time.
   *
   * So trust is now declared rather than inferred, and the default is no. A
   * parser added tomorrow cannot quietly inherit "verified" by existing; a
   * person has to set this to true, and should only do so having run it
   * against a real captured alert.
   */
  readonly validatedAgainstRealMail: boolean
  parse(subject: string, bodyHtml: string, bodyText: string): Promise<ParsedTransaction | null>
}
