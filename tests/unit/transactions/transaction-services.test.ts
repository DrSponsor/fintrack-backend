import { describe, expect, it } from 'vitest'
import { NormalizerService } from '../../../src/modules/transactions/services/normalizer.service'

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
