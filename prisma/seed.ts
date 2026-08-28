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

const parserPatterns = [
  { senderDomain: 'gtbank.com', bankName: 'Guaranty Trust Bank' },
  { senderDomain: 'accessbankplc.com', bankName: 'Access Bank' },
  { senderDomain: 'zenithbank.com', bankName: 'Zenith Bank' },
  { senderDomain: 'ubagroup.com', bankName: 'United Bank for Africa' },
  { senderDomain: 'firstbanknigeria.com', bankName: 'First Bank of Nigeria' },
  { senderDomain: 'kudabank.com', bankName: 'Kuda Bank' },
  { senderDomain: 'opay-nigeria.com', bankName: 'OPay' },
  { senderDomain: 'moniepoint.com', bankName: 'Moniepoint' },
] as const

async function seed(): Promise<void> {
  const categoryRecords = new Map<string, { id: string }>()

  // 1. Seed categories
  for (const category of categories) {
    const record = await prisma.category.upsert({
      where: { name: category.name },
      create: category,
      update: { icon: category.icon, displayName: category.displayName },
      select: { id: true },
    })
    categoryRecords.set(category.name, record)
  }

  // 2. Seed category keywords
  for (const [categoryName, categoryKeywords] of Object.entries(keywords)) {
    const category = categoryRecords.get(categoryName)
    if (category === undefined) {
      throw new Error(`Missing seeded category: ${categoryName}`)
    }

    for (const keyword of categoryKeywords) {
      await prisma.categoryKeyword.upsert({
        where: {
          categoryId_keyword: {
            categoryId: category.id,
            keyword,
          },
        },
        create: {
          categoryId: category.id,
          keyword,
        },
        update: {},
      })
    }
  }

  // 3. Seed ParserPattern stubs
  for (const pattern of parserPatterns) {
    await prisma.parserPattern.upsert({
      where: { senderDomain: pattern.senderDomain },
      create: {
        senderDomain: pattern.senderDomain,
        bankName: pattern.bankName,
        status: 'STABLE',
        patterns: {},
        aiGenerated: false,
        lastValidated: new Date(),
      },
      update: {
        bankName: pattern.bankName,
      },
    })
  }
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
