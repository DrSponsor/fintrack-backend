import CircuitBreaker from 'opossum'
import type { IAIProvider, CategorizationResult, ReportSummary } from './ai-provider.interface'

export type DeepSeekProviderDeps = {
  readonly apiKey: string
  readonly categoriesMap: ReadonlyMap<string, string> // name -> ID map
}

export class DeepSeekProvider implements IAIProvider {
  public readonly providerName = 'deepseek'
  private readonly apiKey: string
  private readonly categoriesMap: ReadonlyMap<string, string>
  private readonly breaker: CircuitBreaker<[string, string, string], string>

  public constructor(deps: DeepSeekProviderDeps) {
    this.apiKey = deps.apiKey
    this.categoriesMap = deps.categoriesMap

    this.breaker = new CircuitBreaker(
      this.callDeepSeek.bind(this),
      {
        timeout: 8000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    )

    // Setup action-specific fallback values when the circuit is open or requests fail
    this.breaker.fallback((_err: Error, action: string) => {
      if (action === 'categorize') {
        return JSON.stringify({ category: 'uncategorised', confidence: 0 })
      }
      if (action === 'pattern') {
        return '{}'
      }
      return 'Could not generate AI insights at this time. This is a spending summary, not financial advice.'
    })
  }

  private async callDeepSeek(
    action: 'categorize' | 'insight' | 'pattern',
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    if (this.apiKey.length === 0) {
      throw new Error('DEEPSEEK_API_KEY is not configured')
    }

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        response_format:
          action === 'categorize' || action === 'pattern'
            ? { type: 'json_object' }
            : undefined,
      }),
    })

    if (!response.ok) {
      throw new Error(`DeepSeek API failed with status ${response.status}: ${await response.text()}`)
    }

    const json = await response.json() as {
      readonly choices?: readonly {
        readonly message?: {
          readonly content?: string
        }
      }[]
    }

    const content = json.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('Invalid response structure from DeepSeek API')
    }

    return content
  }

  public async categorize(merchantName: string, amountKobo: bigint): Promise<CategorizationResult> {
    const categoriesList = Array.from(this.categoriesMap.keys()).join(', ')
    const systemPrompt = `You are a financial transaction categorizer. Categorize the given merchant name into one of these categories: [${categoriesList}].
Return a JSON object containing:
- "category": the exact name of the matched category from the list.
- "confidence": a number from 0 to 1 representing your confidence.
`
    const userPrompt = `Merchant: "${merchantName}", Amount in Kobo: ${amountKobo.toString()}`

    try {
      const responseText = await this.breaker.fire('categorize', systemPrompt, userPrompt)
      const parsed = JSON.parse(responseText) as { readonly category?: string; readonly confidence?: number }
      const categoryName = String(parsed.category ?? 'uncategorised').toLowerCase().trim()
      const confidence = Number(parsed.confidence) || 0

      const categoryId =
        this.categoriesMap.get(categoryName) ??
        this.categoriesMap.get('uncategorised') ??
        'uncategorised'

      return { categoryId, confidence }
    } catch {
      const fallbackId = this.categoriesMap.get('uncategorised') ?? 'uncategorised'
      return { categoryId: fallbackId, confidence: 0 }
    }
  }

  public async generateInsightNarrative(reportSummary: ReportSummary): Promise<string> {
    const systemPrompt = `You are a personal finance tracking assistant.
Describe spending patterns factually.

RULES:
- Describe what happened. Never prescribe what to do with money.
- Never name specific investment products, savings accounts, or financial institutions.
- Never predict future market conditions.
- Frame everything as observation: "You spent ₦X on Y" not "You should...".
- End every response with: "This is a spending summary, not financial advice."
`
    const userPrompt = `Report Summary:
Period: ${reportSummary.periodStart} to ${reportSummary.periodEnd}
Total Spent (Kobo): ${reportSummary.totalSpentKobo}
Total Income (Kobo): ${reportSummary.totalIncomeKobo}
`
    try {
      return await this.breaker.fire('insight', systemPrompt, userPrompt)
    } catch {
      return 'Could not generate AI insights at this time. This is a spending summary, not financial advice.'
    }
  }

  public async generateParserPattern(emailSample: string): Promise<Record<string, string>> {
    const systemPrompt = `You are an expert parser generator. Inspect the given bank transaction email and extract a structured regex or field mapping to extract:
- "amount_kobo"
- "type" (DEBIT or CREDIT)
- "merchant_name"
- "date"
- "balance_kobo"
Return a JSON object with keys and corresponding string regex patterns or extraction rules.
`
    try {
      const responseText = await this.breaker.fire('pattern', systemPrompt, emailSample)
      return JSON.parse(responseText) as Record<string, string>
    } catch {
      return {}
    }
  }
}
