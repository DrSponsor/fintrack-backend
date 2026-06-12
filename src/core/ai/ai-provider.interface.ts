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

  categorize(merchantName: string, amountKobo: bigint): Promise<CategorizationResult>

  generateInsightNarrative(reportSummary: ReportSummary): Promise<string>

  generateParserPattern(emailSample: string): Promise<Record<string, string>>
}
