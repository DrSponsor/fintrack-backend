/* eslint-disable no-console -- a developer diagnostic run by hand; its console
   output IS the deliverable. It is not imported by the server or the worker. */
/**
 * Runs the AI categoriser against the counterparties actually found in this
 * project's real mailbox, and prints what it decides.
 *
 * The point is not that it passes. It is to see whether the model does the
 * RIGHT thing on the case that dominates Nigerian retail banking: a
 * counterparty that is a person, carrying no category at all. The correct
 * answer there is "transfers", or low-confidence uncategorised — never a
 * confident guess at a spending category from someone's name.
 *
 *   npm run test:categorizer
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GeminiProvider } from '../src/core/ai/gemini.provider'

/** The 16 seeded categories, as the app stores them. */
const CATEGORIES = [
  'airtime-data', 'business', 'education', 'entertainment', 'fees-charges',
  'food-groceries', 'health', 'investments', 'rent', 'salary', 'shopping',
  'subscriptions', 'transfers', 'transport', 'uncategorised', 'utilities',
]

type Case = {
  readonly merchant: string
  readonly kobo: bigint
  readonly direction: 'DEBIT' | 'CREDIT'
  /** What a careful human would accept. Several answers are defensible, so
   *  this is a set rather than a single value. */
  readonly acceptable: readonly string[]
  readonly note: string
}

/** Every counterparty below is real, taken from the captured transactions. */
const CASES: readonly Case[] = [
  {
    merchant: 'Paystack', kobo: 789_000n, direction: 'CREDIT',
    acceptable: ['salary', 'business', 'transfers'],
    note: 'processor on a CREDIT — income, never shopping',
  },
  {
    merchant: 'Mary Okafor Roe', kobo: 950_000n, direction: 'DEBIT',
    acceptable: ['transfers', 'uncategorised'],
    note: 'a person — a name carries no spending category',
  },
  {
    merchant: 'Peter Chukwu Poe', kobo: 950_000n, direction: 'DEBIT',
    acceptable: ['transfers', 'uncategorised'],
    note: 'a person',
  },
  {
    merchant: 'Grace Amina Coe', kobo: 300_000n, direction: 'CREDIT',
    acceptable: ['transfers', 'uncategorised', 'salary', 'business'],
    note: 'a person, inbound',
  },
  {
    merchant: 'Web Pymt Spotify 234000000000 00ng', kobo: 160_000n, direction: 'DEBIT',
    acceptable: ['subscriptions', 'entertainment'],
    note: 'a real merchant buried in payment-rail noise',
  },
  {
    merchant: 'Prime Visa Classic: Issuance Fee', kobo: 100_000n, direction: 'DEBIT',
    acceptable: ['fees-charges'],
    note: 'a bank charge',
  },
  {
    merchant: 'Pos Pymt Samuel Bello Loe Lagos L', kobo: 42_000n, direction: 'DEBIT',
    acceptable: ['shopping', 'food-groceries', 'transfers', 'uncategorised'],
    note: 'POS at a person-named merchant — genuinely ambiguous',
  },
]

function envValue(name: string): string {
  const env = readFileSync(resolve(process.cwd(), '.env'), 'utf8')
  const line = env.split('\n').find((l) => l.startsWith(`${name}=`))
  return (line ?? '').split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '')
}

async function main(): Promise<void> {
  // Identity map: the provider maps a returned name through categoriesMap, so
  // name -> name lets the decision be read directly.
  const categoriesMap = new Map(CATEGORIES.map((c) => [c, c]))
  const model = envValue('GEMINI_MODEL')
  const provider = new GeminiProvider({
    apiKey: envValue('GEMINI_API_KEY'),
    categoriesMap,
    ...(model ? { model } : {}),
  })

  console.log(`provider: gemini${model ? ` (${model})` : ''}\n`)
  console.log('counterparty                            dir     decided        conf  ok')
  console.log('-'.repeat(82))

  let good = 0
  for (const c of CASES) {
    const result = await provider.categorize(c.merchant, c.kobo, c.direction)
    const ok = c.acceptable.includes(result.categoryId)
    if (ok) good += 1
    console.log(
      `${c.merchant.slice(0, 38).padEnd(38)}  ${c.direction.padEnd(6)}  ` +
      `${result.categoryId.padEnd(14)} ${result.confidence.toFixed(2)}  ${ok ? 'yes' : 'NO'}`,
    )
    if (!ok) console.log(`${' '.repeat(40)}expected one of: ${c.acceptable.join(', ')}  (${c.note})`)
  }

  console.log('-'.repeat(82))
  console.log(`${good}/${CASES.length} acceptable`)
}

void main()
