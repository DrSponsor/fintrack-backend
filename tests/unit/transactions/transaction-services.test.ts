import { describe, expect, it } from 'vitest'
import { NormalizerService } from '../../../src/modules/transactions/services/normalizer.service'
import { DeduplicatorService } from '../../../src/modules/transactions/services/deduplicator.service'
import { FakeRedis } from '../../helpers/fakes'
import type { Redis } from 'ioredis'

describe('NormalizerService', () => {
  const normalizer = new NormalizerService()

  it('normalizes merchant name correctly (title-cases and trims excess spaces)', () => {
    expect(normalizer.normalizeMerchantName('  OPAY   NIGERIA LTD  ')).toBe('Opay Nigeria Ltd')
    expect(normalizer.normalizeMerchantName('netflix')).toBe('Netflix')
    expect(normalizer.normalizeMerchantName('')).toBe('Unknown Merchant')
  })

  it('generates merchant fingerprint (lowercase alphanumeric only)', () => {
    expect(normalizer.getMerchantFingerprint('Opay Nigeria Ltd')).toBe('opaynigerialtd')
    expect(normalizer.getMerchantFingerprint('Netflix Inc.')).toBe('netflixinc')
    expect(normalizer.getMerchantFingerprint('Kuda / Transfer')).toBe('kudatransfer')
  })
})

describe('DeduplicatorService', () => {
  it('computes consistent hashes for the same bucket window', () => {
    const fakeRedis = new FakeRedis() as unknown as Redis
    const service = new DeduplicatorService({ redis: fakeRedis })

    const date = new Date('2026-06-13T20:00:00.000Z')
    const hash1 = service.getTransactionHash('1234', 5000n, date)
    const hash2 = service.getTransactionHash('1234', 5000n, date)

    expect(hash1).toBe(hash2)
  })

  it('computes different hashes for different buckets', () => {
    const fakeRedis = new FakeRedis() as unknown as Redis
    const service = new DeduplicatorService({ redis: fakeRedis })

    const date1 = new Date('2026-06-13T20:00:00.000Z')
    const date2 = new Date('2026-06-13T20:06:00.000Z') // 6 minutes later, different bucket

    const hash1 = service.getTransactionHash('1234', 5000n, date1)
    const hash2 = service.getTransactionHash('1234', 5000n, date2)

    expect(hash1).not.toBe(hash2)
  })

  it('finds duplicates and tracks transactions', async () => {
    const fakeRedis = new FakeRedis() as unknown as Redis
    const service = new DeduplicatorService({ redis: fakeRedis })

    const hash = 'sample-hash'
    const txId = 'sample-tx-id'

    // Not a duplicate initially
    expect(await service.findDuplicate(hash)).toBeNull()

    // Track it
    await service.trackTransaction(hash, txId)

    // Now it is a duplicate
    expect(await service.findDuplicate(hash)).toBe(txId)
  })
})
