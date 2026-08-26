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
}

export interface IEmailParser {
  readonly parserId: string
  readonly bankName: string
  readonly supportedDomains: readonly string[]
  parse(subject: string, bodyHtml: string, bodyText: string): Promise<ParsedTransaction | null>
}
