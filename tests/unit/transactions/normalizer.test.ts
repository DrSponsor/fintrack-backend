import { describe, expect, it } from 'vitest'
import { NormalizerService } from '../../../src/modules/transactions/services/normalizer.service'

const normalizer = new NormalizerService()
const name = (raw: string): string => normalizer.normalizeMerchantName(raw)

describe('normalizeMerchantName', () => {
  it('leaves a name that already has lowercase letters alone', () => {
    // Deliberate casing from a person or a well-formed source. Re-casing it
    // can only lose information — this is the regression that printed "Mtn
    // Airtime" and "Dstv Subscription" on every ledger row.
    expect(name('MTN Airtime')).toBe('MTN Airtime')
    expect(name('DSTV Subscription')).toBe('DSTV Subscription')
    expect(name('iTunes')).toBe('iTunes')
  })

  it('title-cases a shouting bank alert', () => {
    expect(name('SHOPRITE IKEJA CITY MALL')).toBe('Shoprite Ikeja City Mall')
  })

  it('keeps short all-caps tokens, which are acronyms', () => {
    expect(name('GTB LAGOS')).toBe('GTB Lagos')
    expect(name('POS PURCHASE LEKKI')).toBe('POS Purchase Lekki')
  })

  it('does not mistake four-letter words in a shouting alert for acronyms', () => {
    // The cutoff is three for exactly this: at four, CITY and MALL survived
    // uppercase and the row read "Shoprite Ikeja CITY MALL". Once the whole
    // string is uppercase there is nothing left to tell CITY from DSTV, so the
    // rule is set to fail on the rarer case.
    expect(name('SHOPRITE IKEJA CITY MALL')).toBe('Shoprite Ikeja City Mall')
    expect(name('CASH WITHDRAWAL ATM')).toBe('Cash Withdrawal ATM')
  })

  it('collapses runs of whitespace', () => {
    expect(name('  Chicken   Republic  ')).toBe('Chicken Republic')
  })

  it('names an empty value rather than returning one', () => {
    expect(name('   ')).toBe('Unknown Merchant')
  })

  it('does not change the fingerprint a name produces', () => {
    // Casing is presentation only. If this ever stopped holding, every
    // existing user preference and shared mapping would stop matching.
    const shouting = normalizer.getMerchantFingerprint(name('SHOPRITE'))
    const typed = normalizer.getMerchantFingerprint(name('Shoprite'))
    expect(shouting).toBe(typed)
    expect(shouting).toBe('shoprite')
  })
})
