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
  parse(subject: string, bodyHtml: string, bodyText: string): Promise<ParsedTransaction | null>
}
