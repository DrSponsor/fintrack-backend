import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const categories = [
  { name: 'uncategorised', icon: 'circle-help' },
  { name: 'food', icon: 'utensils' },
  { name: 'transport', icon: 'bus' },
  { name: 'utilities', icon: 'lightbulb' },
  { name: 'airtime-data', icon: 'smartphone' },
  { name: 'rent', icon: 'home' },
  { name: 'salary', icon: 'briefcase-business' },
  { name: 'shopping', icon: 'shopping-bag' },
  { name: 'health', icon: 'heart-pulse' },
  { name: 'education', icon: 'graduation-cap' },
  { name: 'entertainment', icon: 'ticket' },
  { name: 'fees-charges', icon: 'receipt' },
] as const

const keywords = {
  food: ['restaurant', 'food', 'chicken', 'pizza', 'eatery'],
  transport: ['uber', 'bolt', 'transport', 'fuel', 'bus'],
  utilities: ['electricity', 'power', 'water', 'utility'],
  'airtime-data': ['airtime', 'data', 'mtn', 'glo', 'airtel', '9mobile'],
  rent: ['rent', 'landlord', 'housing'],
  salary: ['salary', 'payroll', 'wage'],
  shopping: ['market', 'store', 'mall', 'shop'],
  health: ['hospital', 'pharmacy', 'clinic'],
  education: ['school', 'tuition', 'course'],
  entertainment: ['cinema', 'netflix', 'spotify'],
  'fees-charges': ['charge', 'fee', 'vat'],
} as const

async function seed(): Promise<void> {
  const categoryRecords = new Map<string, { id: string }>()

  for (const category of categories) {
    const record = await prisma.category.upsert({
      where: { name: category.name },
      create: category,
      update: { icon: category.icon },
      select: { id: true },
    })
    categoryRecords.set(category.name, record)
  }

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
}

void seed()
  .catch((error: unknown) => {
    process.stderr.write(`Seed failed: ${String(error)}\n`)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
