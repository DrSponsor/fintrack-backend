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
  /**
   * A raw completion against an arbitrary prompt, returning JSON text.
   *
   * The typed methods above each encode one job. This is for work that is not
   * a permanent capability of the system — account discovery runs once when an
   * inbox is connected and a person checks the result immediately — where
   * adding a bespoke provider method per use would grow the interface faster
   * than it grows the product.
   *
   * Null on failure rather than throwing: every caller of this is best-effort
   * by construction.
   */
  complete(systemPrompt: string, userPrompt: string): Promise<string | null>

  categorize(
    merchantName: string,
    amountKobo: bigint,
    direction: 'DEBIT' | 'CREDIT',
  ): Promise<CategorizationResult>

  generateInsightNarrative(reportSummary: ReportSummary): Promise<string>

  generateParserPattern(emailSample: string): Promise<Record<string, string>>
}
