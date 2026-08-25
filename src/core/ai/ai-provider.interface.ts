export type CategorizationResult = {
  readonly categoryId: string
  readonly confidence: number
}

export type ReportSummary = {
  readonly schemaVersion: number
  readonly periodStart: string
  readonly periodEnd: string
  readonly totalSpentKobo: string
  readonly totalIncomeKobo: string
}

export interface IAIProvider {
  readonly providerName: string

  /**
   * `direction` is not optional context — it is often the deciding fact.
   *
   * "Paystack" for ₦7,890 is income when the money arrives and a purchase when
   * it leaves, and the merchant name alone cannot separate the two. Categorising
   * without it was guesswork dressed as a decision.
   */
  categorize(
    merchantName: string,
    amountKobo: bigint,
    direction: 'DEBIT' | 'CREDIT',
  ): Promise<CategorizationResult>

  generateInsightNarrative(reportSummary: ReportSummary): Promise<string>

  generateParserPattern(emailSample: string): Promise<Record<string, string>>
}
