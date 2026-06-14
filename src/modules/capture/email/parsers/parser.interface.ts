export type ParsedTransaction = {
  readonly amountKobo: bigint
  readonly type: 'DEBIT' | 'CREDIT'
  readonly merchantName: string
  readonly transactionDate: Date
  readonly balanceAfterKobo?: bigint
}

export interface IEmailParser {
  readonly parserId: string
  readonly bankName: string
  readonly supportedDomains: readonly string[]

  parse(subject: string, bodyHtml: string, bodyText: string): Promise<ParsedTransaction | null>
}
