import CircuitBreaker from 'opossum'
import type { IAIProvider, CategorizationResult, ReportSummary } from './ai-provider.interface'
import { circuitBreakerStateGauge } from '../observability/metrics'
import {
  categorizePrompt,
  insightPrompt,
  insightUserPrompt,
  parserPatternPrompt,
} from './prompts'

/**
 * Default model.
 *
 * This was `deepseek-chat`, which STOPPED RESOLVING on 24 July 2026 when
 * DeepSeek retired the legacy aliases in favour of the v4 names. Calls with the
 * old name return an HTTP error, which surfaces here as "AI provider failed to
 * generate patterns" — indistinguishable from a missing key or an open circuit
 * breaker, and therefore very easy to misdiagnose.
 *
 * v4-flash rather than v4-pro: the work is field extraction and classification
 * against a short document, which is exactly what flash is for, at roughly a
 * third of the price.
 */
const DEFAULT_MODEL = 'deepseek-v4-flash'

export type DeepSeekProviderDeps = {
  readonly apiKey: string
  readonly categoriesMap: ReadonlyMap<string, string> // name -> ID map
  /** Overridable so a future rename is an env change, not a deploy. */
  readonly model?: string | undefined
}

export class DeepSeekProvider implements IAIProvider {
  public readonly providerName = 'deepseek'
  private readonly apiKey: string
  private readonly model: string
  private readonly categoriesMap: ReadonlyMap<string, string>
  private readonly breaker: CircuitBreaker<[string, string, string], string>
  /** Reason the last pattern generation failed. Diagnostic only — see
   *  getLastError. */
  private lastError: string | undefined

  public constructor(deps: DeepSeekProviderDeps) {
    this.apiKey = deps.apiKey
    this.model = deps.model && deps.model.length > 0 ? deps.model : DEFAULT_MODEL
    this.categoriesMap = deps.categoriesMap

    this.breaker = new CircuitBreaker(
      this.callDeepSeek.bind(this),
      {
        timeout: 8000,
        errorThresholdPercentage: 50,
        resetTimeout: 30000,
      }
    )

    // Hook circuit breaker state changes to the Prometheus gauge
    this.breaker.on('open', () => circuitBreakerStateGauge.set({ name: 'deepseek' }, 1))
    this.breaker.on('close', () => circuitBreakerStateGauge.set({ name: 'deepseek' }, 0))
    this.breaker.on('halfOpen', () => circuitBreakerStateGauge.set({ name: 'deepseek' }, 2))

    // Set initial state to closed (0)
    circuitBreakerStateGauge.set({ name: 'deepseek' }, 0)

    // Setup action-specific fallback values when the circuit is open or requests fail.
    // opossum calls this with the original .fire() args first, error last —
    // see the comment on CircuitBreaker.fallback in src/types/opossum.d.ts.
    // The error is recorded here because a fallback RESOLVES rather than
    // rejects, so the catch around fire() never sees it and the reason would be
    // lost — see the matching note in gemini.provider.ts.
    this.breaker.fallback((action: string, _systemPrompt: string, _userPrompt: string, err?: Error) => {
      if (err !== undefined) {
        this.lastError = err.message
      }
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
        model: this.model,
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
    const systemPrompt = categorizePrompt(Array.from(this.categoriesMap.keys()))
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
    try {
      return await this.breaker.fire('insight', insightPrompt, insightUserPrompt(reportSummary))
    } catch {
      return 'Could not generate AI insights at this time. This is a spending summary, not financial advice.'
    }
  }

  public async generateParserPattern(emailSample: string): Promise<Record<string, string>> {
    // Cleared BEFORE the call, never after. A circuit-breaker fallback
    // RESOLVES rather than rejects, so clearing on the success path wiped the
    // reason the fallback had just recorded — which is why a 404 for a retired
    // model surfaced as "no reason recorded".
    this.lastError = undefined
    try {
      const responseText = await this.breaker.fire('pattern', parserPatternPrompt, emailSample)
      return JSON.parse(responseText) as Record<string, string>
    } catch (err) {
      // Rethrow-as-empty is the contract callers expect, but swallowing the
      // reason made four very different failures — no credit (402), a retired
      // model name (400), a bad key (401), and an open circuit breaker — look
      // identical in the logs as "AI provider failed to generate patterns".
      // Diagnosing `deepseek-chat` cost real time to exactly this. The reason
      // is now recorded even though the shape of the return value is unchanged.
      this.lastError = err instanceof Error ? err.message : String(err)
      return {}
    }
  }

  /**
   * Why the most recent generateParserPattern call returned nothing.
   *
   * Read by callers for logging only. Deliberately not part of IAIProvider:
   * it is a diagnostic, and no control flow should branch on it.
   */
  public getLastError(): string | undefined {
    return this.lastError
  }
}
