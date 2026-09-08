import { PrismaClient } from '../src/generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import 'dotenv/config'

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DIRECT_URL or DATABASE_URL environment variable is required for seeding')
}
const pool = new Pool({ connectionString })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

// `name` is the slug every lookup uses and is never shown to anyone.
// `displayName` is what appears on a ledger row. Keeping both here means
// adding a category is one edit, and no client has to know how to turn
// "food-groceries" into something a person would say — which is how "Airtime
// & data" ended up on screen as "airtime-data".
const categories = [
  { name: 'uncategorised', displayName: 'Uncategorised', icon: 'circle-help' },
  { name: 'food-groceries', displayName: 'Food & groceries', icon: 'utensils' },
  { name: 'transport', displayName: 'Transport', icon: 'bus' },
  { name: 'airtime-data', displayName: 'Airtime & data', icon: 'smartphone' },
  { name: 'utilities', displayName: 'Utilities', icon: 'lightbulb' },
  { name: 'entertainment', displayName: 'Entertainment', icon: 'ticket' },
  { name: 'health', displayName: 'Health', icon: 'heart-pulse' },
  { name: 'education', displayName: 'Education', icon: 'graduation-cap' },
  { name: 'shopping', displayName: 'Shopping', icon: 'shopping-bag' },
  { name: 'transfers', displayName: 'Transfers', icon: 'arrow-left-right' },
  { name: 'subscriptions', displayName: 'Subscriptions', icon: 'calendar-repeat' },
  { name: 'rent', displayName: 'Rent', icon: 'home' },
  { name: 'salary', displayName: 'Salary', icon: 'briefcase-business' },
  { name: 'fees-charges', displayName: 'Fees & charges', icon: 'receipt' },
  { name: 'investments', displayName: 'Investments', icon: 'trending-up' },
  { name: 'business', displayName: 'Business', icon: 'store' },
] as const

const keywords: Record<string, readonly string[]> = {
  'food-groceries': ['restaurant', 'food', 'chicken', 'pizza', 'eatery', 'groceries', 'supermarket', 'chow', 'spaghetti', 'burger', 'bakery', 'bukka', 'buka', 'kitchen', 'canteen'],
  transport: ['uber', 'bolt', 'transport', 'fuel', 'bus', 'ride', 'cab', 'airline', 'flight', 'petrol', 'diesel', 'filling station', 'railway', 'logistics'],
  'airtime-data': ['airtime', 'data', 'mtn', 'glo', 'airtel', '9mobile', 'spectranet', 'smile', 'recharge', 'credit purchase'],
  utilities: ['electricity', 'power', 'water', 'utility', 'ekedc', 'ikedc', 'aedc', 'ibedc', 'kedco', 'waste', 'sewage'],
  entertainment: ['cinema', 'netflix', 'spotify', 'showmax', 'dstv', 'gotv', 'betting', 'bet9ja', 'sportybet', 'club', 'bar', 'lounge', 'concert', 'event', 'pub', 'gaming', 'casino'],
  health: ['hospital', 'pharmacy', 'clinic', 'medical', 'drug', 'dentist', 'health', 'fitness', 'gym', 'spa', 'eyecare', 'optician'],
  education: ['school', 'tuition', 'course', 'exam', 'waec', 'jamb', 'book', 'library', 'academy', 'varsity', 'university', 'college', 'seminar'],
  shopping: ['market', 'store', 'mall', 'shop', 'jumia', 'konga', 'amazon', 'boutique', 'fashion', 'clothing', 'electronics', 'superstore'],
  transfers: ['transfer', 'send', 'wire', 'deposit', 'withdrawal', 'p2p', 'cashout', 'funding'],
  subscriptions: ['subscription', 'sub', 'membership', 'cloud', 'aws', 'google', 'apple', 'adobe', 'zoom', 'github', 'azure', 'patreon', 'subscribestar'],
  rent: ['rent', 'landlord', 'housing', 'apartment', 'estate', 'leasing', 'tenant'],
  salary: ['salary', 'payroll', 'wage', 'allowance', 'bonus', 'commission', 'stipend'],
  'fees-charges': ['charge', 'fee', 'vat', 'tax', 'maintenance', 'stamp duty', 'sms charge', 'commission on turnover', 'cot'],
  investments: ['invest', 'mutual fund', 'stock', 'bond', 'savings', 'piggyvest', 'cowrywise', 'bamboo', 'chaka', 'treasury bill', 'crypto', 'binance'],
  business: ['business', 'merchant', 'vendor', 'invoice', 'supplier', 'trade', 'wholesaler', 'retailer'],
}

/**
 * Seeding, in waves rather than one row at a time.
 *
 * This used to await every write in a nested loop: sixteen categories, then a
 * hundred and sixty-eight keywords one by one, then eight parser patterns —
 * about a hundred and ninety sequential round trips. Against a local Postgres
 * that is instant. Against a managed database in another continent, where a
 * handshake alone measured 1.5 seconds, it is roughly five minutes of silence,
 * because the file also logged nothing at all.
 *
 * It was indistinguishable from a hang, and got killed as one.
 */
async function seed(): Promise<void> {
  const step = (message: string): void => {
    process.stdout.write(`  ${message}\n`)
  }

  // Categories keep real upserts: they carry an icon and a display name that
  // must be refreshed on an existing row. Run together rather than in
  // sequence — sixteen independent statements have no reason to queue behind
  // one another.
  const settled = await Promise.all(
    categories.map(async (category) => {
      const record = await prisma.category.upsert({
        where: { name: category.name },
        create: category,
        update: { icon: category.icon, displayName: category.displayName },
        select: { id: true },
      })
      return [category.name, record] as const
    }),
  )
  // Keyed by plain string, not by the literal union `categories` infers. The
  // keywords object is looked up with Object.entries, which widens its keys to
  // string, and a narrower map key would reject every one of them.
  const categoryRecords = new Map<string, { id: string }>(settled)
  step(`categories: ${categoryRecords.size}`)

  // Keywords are createMany, not upsert. The old upsert had `update: {}` — it
  // did nothing on conflict — so skipDuplicates is exactly equivalent, and it
  // collapses a hundred and sixty-eight round trips into one statement.
  const keywordRows = Object.entries(keywords).flatMap(([categoryName, categoryKeywords]) => {
    const category = categoryRecords.get(categoryName)
    if (category === undefined) {
      throw new Error(`Missing seeded category: ${categoryName}`)
    }
    return categoryKeywords.map((keyword) => ({ categoryId: category.id, keyword }))
  })

  const written = await prisma.categoryKeyword.createMany({
    data: keywordRows,
    skipDuplicates: true,
  })
  step(`keywords: ${keywordRows.length} offered, ${written.count} new`)

  // Parser patterns are NOT seeded, and must not be.
  //
  // This inserted all eight banks with `patterns: {}` and `status: 'STABLE'`
  // as placeholders. AIUniversalParser looks a domain up before generating,
  // and the row merely EXISTING was enough to take the "we already have a
  // pattern" branch — so it applied an empty object, matched nothing, and
  // never reached the generation path. Permanently.
  //
  // The result was the exact inverse of what the fixture intended. Alerts from
  // Access, GTBank, Zenith, UBA, First Bank, Kuda, Moniepoint and Opay could
  // never be parsed, while unknown senders like substack.com and corel.com got
  // working AI-generated parsers on first contact. The banks this app exists
  // to read were the only ones it was incapable of reading, and nothing failed
  // loudly enough to say so.
  //
  // `status: 'STABLE'` made it worse: that is the highest trust level in the
  // system, asserted on a pattern containing nothing.
  //
  // A pattern is earned by parsing a real email, not declared by a fixture.
  // The parser writes its own row on first contact with a domain, and leaving
  // this table empty is what lets it. The parser now also treats an empty
  // stored pattern as absent, so a stale placeholder heals itself — that is a
  // safety net, not a licence to put these back.
  step('parser patterns: none seeded, by design')
}
void seed()
  .catch((error: unknown) => {
    process.stderr.write(`Seed failed: ${String(error)}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
