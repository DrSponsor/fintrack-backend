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
 * Google Gemini, via the Generative Language API.
 *
 * Added alongside DeepSeek because Gemini's free tier requires no card and does
 * not expire, which makes it the tier you can actually evaluate a pipeline on.
 * DeepSeek's promotional grant is campaign-dependent and did not materialise on
 * this project's account — the first real call came back HTTP 402.
 *
 * ── Where this differs from an OpenAI-shaped API ─────────────────────────
 * Three things, and all three are easy to get wrong silently:
 *
 *   THE KEY IS NOT A BEARER TOKEN. Google accepts it as a `?key=` query
 *   parameter or an `x-goog-api-key` header; an `Authorization: Bearer` header
 *   is not recognised. This uses the header so the secret never lands in a URL
 *   a proxy or access log might retain.
 *
 *   THE MODEL IS IN THE URL PATH, not the body. So an unknown model name is a
 *   404 on a URL rather than a validation error about a field.
 *
 *   THE SYSTEM PROMPT IS A SEPARATE TOP-LEVEL FIELD (`systemInstruction`), not
 *   a message with role "system". Passing it as a message does not error — it
 *   is simply treated as user text, which quietly weakens every instruction.
 *
 * JSON mode is `responseMimeType: 'application/json'` in generationConfig,
 * which is what keeps the pattern generator from wrapping its object in a
 * markdown fence and breaking JSON.parse.
 */

/**
 * Default model.
 *
 * Flash-Lite rather than Pro: this workload is field extraction and
 * classification over a short document, and on the free tier it carries the
 * most generous request-per-day allowance of the family — which is the limit
 * that actually binds when backfilling a mailbox.
 *
 * Model names in this family turn over quickly and old ones are retired, so
 * this is overridable by env.
 *
 * Do NOT verify a model name with ListModels alone. `gemini-2.5-flash-lite`
 * was listed as available on this project's key and returned 404 on the first
 * real call: "no longer available to new users". Listing reflects the catalogue,
 * not what an individual account may invoke. The only reliable check is an
 * actual generateContent call — which is what scripts/test-ai-parser.ts does.
 */
const DEFAULT_MODEL = 'gemini-3.5-flash-lite'

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta'

export type GeminiProviderDeps = {
  readonly apiKey: string
  readonly categoriesMap: ReadonlyMap<string, string>
  readonly model?: string | undefined
}

type GeminiAction = 'categorize' | 'insight' | 'pattern'

export class GeminiProvider implements IAIProvider {
  public readonly providerName = 'gemini'
  private readonly apiKey: string
  private readonly model: string
  private readonly categoriesMap: ReadonlyMap<string, string>
  private readonly breaker: CircuitBreaker<[GeminiAction, string, string], string>
  private lastError: string | undefined

  public constructor(deps: GeminiProviderDeps) {
    this.apiKey = deps.apiKey
    this.model = deps.model && deps.model.length > 0 ? deps.model : DEFAULT_MODEL
    this.categoriesMap = deps.categoriesMap

    this.breaker = new CircuitBreaker(this.callGemini.bind(this), {
      timeout: 15000,
      errorThresholdPercentage: 50,
      resetTimeout: 30000,
    })

    this.breaker.on('open', () => circuitBreakerStateGauge.set({ name: 'gemini' }, 1))
    this.breaker.on('close', () => circuitBreakerStateGauge.set({ name: 'gemini' }, 0))
    this.breaker.on('halfOpen', () => circuitBreakerStateGauge.set({ name: 'gemini' }, 2))
    circuitBreakerStateGauge.set({ name: 'gemini' }, 0)

    // Same fallback shapes as the DeepSeek provider: callers parse these, so
    // an open breaker must still return something structurally valid.
    //
    // The error is captured HERE, not only in the catch around fire(). A
    // fallback RESOLVES the promise rather than rejecting it, so the catch
    // never runs and the reason would otherwise be lost — which is exactly what
    // produced "provider returned nothing (no reason recorded)" on the first
    // real Gemini run, hiding the actual API response.
    this.breaker.fallback(
      (action: GeminiAction, _systemPrompt: string, _userPrompt: string, err?: Error) => {
        if (err !== undefined) {
          this.lastError = err.message
        }
        if (action === 'categorize') {
          return JSON.stringify({ category: 'uncategorised', confidence: 0 })
        }
        if (action === 'pattern') return '{}'
        return 'Could not generate AI insights at this time. This is a spending summary, not financial advice.'
      },
    )
  }

  private async callGemini(
    action: GeminiAction,
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    if (this.apiKey.length === 0) {
      throw new Error('GEMINI_API_KEY is not configured')
    }

    const url = `${API_ROOT}/models/${encodeURIComponent(this.model)}:generateContent`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Header form rather than ?key=, so the secret never lands in a URL
        // that a proxy or access log might record.
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        // A first-class field, NOT a message with role "system".
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          ...(action === 'categorize' || action === 'pattern'
            ? { responseMimeType: 'application/json' }
            : {}),
        },
      }),
    })

    if (!response.ok) {
      throw new Error(`Gemini API failed with status ${response.status}: ${await response.text()}`)
    }

    const json = (await response.json()) as {
      readonly candidates?: readonly {
        readonly content?: { readonly parts?: readonly { readonly text?: string }[] }
        readonly finishReason?: string
      }[]
      readonly promptFeedback?: { readonly blockReason?: string }
    }

    // A safety block returns 200 with no candidates. Treated as an error rather
    // than an empty string so it is visible instead of looking like a model
    // that simply had nothing to say.
    const blocked = json.promptFeedback?.blockReason
    if (blocked !== undefined) {
      throw new Error(`Gemini blocked the prompt: ${blocked}`)
    }

    const text = json.candidates?.[0]?.content?.parts?.[0]?.text
    if (typeof text !== 'string') {
      throw new Error('Invalid response structure from Gemini API')
    }

    return text
  }

  public async categorize(
    merchantName: string,
    amountKobo: bigint,
    direction: 'DEBIT' | 'CREDIT',
  ): Promise<CategorizationResult> {
    const systemPrompt = categorizePrompt(Array.from(this.categoriesMap.keys()))
    const userPrompt = `Counterparty: "${merchantName}"
Amount in Kobo: ${amountKobo.toString()}
Direction: ${direction}`

    try {
      const responseText = await this.breaker.fire('categorize', systemPrompt, userPrompt)
      const parsed = JSON.parse(responseText) as {
        readonly category?: string
        readonly confidence?: number
      }
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
      // Recorded rather than swallowed: "no credit", "unknown model", "bad key"
      // and "breaker open" are otherwise one indistinguishable log line, which
      // is precisely how a retired model name stayed hidden on the other
      // provider.
      this.lastError = err instanceof Error ? err.message : String(err)
      return {}
    }
  }

  /** Why the last pattern generation returned nothing. Diagnostic only. */
  public getLastError(): string | undefined {
    return this.lastError
  }
}
