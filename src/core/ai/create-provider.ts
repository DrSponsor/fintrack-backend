import type { AppConfig } from '../../config'
import type { IAIProvider } from './ai-provider.interface'
import { DeepSeekProvider } from './deepseek.provider'
import { GeminiProvider } from './gemini.provider'

/**
 * Chooses an AI provider from configuration.
 *
 * Two construction sites existed before this (the fastify plugin and the manual
 * capture route), each newing up DeepSeek directly. Adding a second provider
 * without a factory means every future site picks one by hand, and they drift.
 *
 * Selection is explicit via AI_PROVIDER, but falls back to whichever key is
 * actually present. That fallback is deliberate: the common setup mistake is
 * supplying a key without naming the provider, and failing on that would be
 * unhelpful when the intent is obvious.
 */
export function createAIProvider(
  config: AppConfig,
  categoriesMap: ReadonlyMap<string, string>,
): IAIProvider {
  const explicit = config.aiProvider?.toLowerCase().trim()

  const useGemini =
    explicit === 'gemini' ||
    (explicit === undefined || explicit.length === 0
      ? // No explicit choice: prefer whichever is configured, and Gemini when
        // both are, because its free tier is the one that works without a card.
        (config.geminiApiKey ?? '').length > 0
      : false)

  if (useGemini) {
    return new GeminiProvider({
      apiKey: config.geminiApiKey ?? '',
      model: config.geminiModel,
      categoriesMap,
    })
  }

  return new DeepSeekProvider({
    apiKey: config.deepseekApiKey ?? '',
    model: config.deepseekModel,
    categoriesMap,
  })
}
