import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')

describe('Prisma schema foundation laws', () => {
  it('stores all monetary fields as BigInt', () => {
    expect(schema).toMatch(/amountKobo\s+BigInt/)
    expect(schema).toMatch(/balanceKobo\s+BigInt/)
    expect(schema).toMatch(/limitKobo\s+BigInt/)
    expect(schema).not.toMatch(/\b(amountKobo|balanceKobo|limitKobo)\s+(Float|Decimal|Int)\b/)
  })

  it('uses UUID primary keys instead of sequential IDs', () => {
    expect(schema).not.toMatch(/@default\(autoincrement\(\)\)/)
    const modelBlocks = schema.match(/model\s+\w+\s+\{[\s\S]*?\n\}/g) ?? []
    expect(modelBlocks.length).toBeGreaterThan(0)
    for (const block of modelBlocks) {
      expect(block).toMatch(/id\s+String\s+@id\s+@default\(uuid\(\)\)/)
    }
  })

  it('contains mandatory transaction and worker indexes', () => {
    expect(schema).toContain('@@index([accountId, transactionDate])')
    expect(schema).toContain('@@index([categoryId, transactionDate])')
    expect(schema).toContain('@@index([userId, periodType])')
    expect(schema).toContain('@@index([status, gracePeriodEndsAt])')
    expect(schema).toContain('@@index([publishedAt, attempts])')
  })

  it('contains at-least-once consumer idempotency constraints', () => {
    expect(schema).toContain('idempotencyKey  String          @unique')
    expect(schema).toContain('@@unique([transactionId, budgetId])')
    expect(schema).toContain('providerEventId String          @unique')
  })

  it('contains the categorisation feedback tables approved for Phase 1', () => {
    expect(schema).toContain('model CategoryKeyword')
    expect(schema).toContain('model MerchantCategoryMap')
    expect(schema).toContain('model UserMerchantPreference')
  })

  it('keeps encrypted snippet naming explicit', () => {
    expect(schema).toContain('rawSnippetEnc')
    expect(schema).not.toContain('rawSnippet      String?')
  })
})
