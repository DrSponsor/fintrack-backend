/* eslint-disable no-console -- a developer diagnostic run by hand; its console
   output IS the deliverable. It is not imported by the server or the worker. */
/**
 * Exercises the real AI pattern-generation path against a real bank email.
 *
 * Imports the actual provider and the actual safety module rather than
 * reimplementing either, so what passes here is what runs in the worker.
 *
 *   npx tsx scripts/test-ai-parser.ts
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { IAIProvider } from '../src/core/ai/ai-provider.interface'
import { DeepSeekProvider } from '../src/core/ai/deepseek.provider'
import { GeminiProvider } from '../src/core/ai/gemini.provider'
import {
  checkPattern,
  redactForModel,
  runPattern,
  verifyExtraction,
  isPlausibleAmountKobo,
} from '../src/modules/capture/email/parsers/pattern-safety'
import { parseAmountKobo } from '../src/modules/capture/email/parsers/utils'

/** The real Access Bank debit alert, flattened as cleanText leaves it. */
const DEBIT =
  'Dear JOHN ADEBAYO DOE, Your account has been Debited NGN 4,989.25 ' +
  'Transaction Summary A/C Number 012******345 Account Name JOHN ADEBAYO DOE ' +
  'Description MOBILE TRF TO PAY/ /JOHN ADEBAYO Reference Number 312ABCD2600000AA ' +
  'Transaction Branch IDIMU BRANCH Transaction Date 17-Aug-2026 Value Date 17-Aug-2026 ' +
  'Available Balance 200,000.00'

/** The real credit alert. Different narrative shape, different counterparty position. */
const CREDIT =
  'Dear JOHN ADEBAYO DOE, Your account has been Credited NGN 14,475.00 ' +
  'Transaction Summary A/C Number 012******345 Account Name JOHN ADEBAYO DOE ' +
  'Description Paystack/PSST10vKoAt88Afi071756082 Reference Number 312NIPL2620500H4 ' +
  'Transaction Branch IDIMU BRANCH Transaction Date 24-Jul-2026 Value Date 24-Jul-2026 ' +
  'Available Balance 242,327.00'

/** Reads one key out of .env without pulling in a config loader. */
function envValue(name: string): string {
  // process.cwd() rather than import.meta.url: this project compiles under a
  // CommonJS module target, where import.meta is a syntax error.
  const env = readFileSync(resolve(process.cwd(), '.env'), 'utf8')
  const line = env.split('\n').find((l) => l.startsWith(`${name}=`))
  return (line ?? '').split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '')
}

/**
 * Builds whichever provider is configured, using the same precedence as
 * createAIProvider so this script exercises the provider the worker would.
 */
function buildProvider(): IAIProvider & { getLastError?: () => string | undefined } {
  const explicit = envValue('AI_PROVIDER').toLowerCase()
  const geminiKey = envValue('GEMINI_API_KEY')
  const deepseekKey = envValue('DEEPSEEK_API_KEY')

  const useGemini = explicit === 'gemini' || (explicit === '' && geminiKey.length > 0)

  if (useGemini) {
    const model = envValue('GEMINI_MODEL')
    console.log(`provider: gemini${model ? ` (${model})` : ''}`)
    return new GeminiProvider({
      apiKey: geminiKey,
      categoriesMap: new Map(),
      ...(model ? { model } : {}),
    })
  }

  const model = envValue('DEEPSEEK_MODEL')
  console.log(`provider: deepseek${model ? ` (${model})` : ''}`)
  return new DeepSeekProvider({
    apiKey: deepseekKey,
    categoriesMap: new Map(),
    ...(model ? { model } : {}),
  })
}

async function run(label: string, text: string, expectedAmount: string): Promise<boolean> {
  console.log(`\n${'='.repeat(66)}\n${label}\n${'='.repeat(66)}`)

  const provider = buildProvider()

  const redacted = redactForModel(text)
  console.log('\n-- what the model is allowed to see --')
  console.log(redacted.slice(0, 240) + (redacted.length > 240 ? ' ...' : ''))

  const patterns = await provider.generateParserPattern(redacted)
  if (Object.keys(patterns).length === 0) {
    // The provider records WHY. Without it, "no credit", "unknown model",
    // "bad key" and "breaker open" are one message — which is how a retired
    // DeepSeek model name stayed hidden for an entire debugging session.
    console.log(`\nFAILED: ${provider.getLastError?.() ?? 'provider returned nothing (no reason recorded)'}`)
    return false
  }

  console.log('\n-- generated --')
  for (const [k, v] of Object.entries(patterns)) console.log(`  ${k}: ${v}`)

  const amountSrc = patterns.amountRegex || patterns.amount_kobo
  if (!amountSrc) {
    console.log('\nFAILED: no amount pattern returned')
    return false
  }

  const check = checkPattern(amountSrc)
  console.log('\n-- safety --')
  if (!check.ok) {
    console.log(`  REJECTED: ${check.reason}`)
    return false
  }
  console.log('  accepted: compiles, has a capture group, no backtracking shapes')

  // Verified against the ORIGINAL text, not the redacted copy — the worker
  // parses real emails, so the pattern has to work on the real thing.
  const extracted = runPattern(check.regex, text)
  const declared = patterns.amountValue || patterns.amount_value
  const verified = verifyExtraction(check.regex, text, declared)

  console.log('\n-- round trip --')
  console.log(`  model declared : ${declared ?? '(none)'}`)
  console.log(`  regex extracted: ${extracted ?? '(no match)'}`)
  console.log(`  truth          : ${expectedAmount}`)
  console.log(`  verified       : ${verified ? 'PASS' : 'FAIL'}`)

  if (!verified) return false

  const kobo = parseAmountKobo(extracted ?? '')
  const plausible = isPlausibleAmountKobo(kobo)
  const correct = extracted !== null && extracted.replace(/,/g, '') === expectedAmount.replace(/,/g, '')
  console.log(`  plausible      : ${plausible}`)
  console.log(`  CORRECT AMOUNT : ${correct ? 'YES' : 'NO — extracted the wrong field'}`)

  return verified && plausible && correct
}

async function main(): Promise<void> {
  const debit = await run('DEBIT alert', DEBIT, '4,989.25')
  const credit = await run('CREDIT alert', CREDIT, '14,475.00')

  console.log(`\n${'='.repeat(66)}`)
  console.log(`debit: ${debit ? 'PASS' : 'FAIL'}   credit: ${credit ? 'PASS' : 'FAIL'}`)
  console.log('='.repeat(66))
}

void main()
