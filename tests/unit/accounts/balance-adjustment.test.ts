import { describe, expect, it } from 'vitest'
import { netAdjustmentKobo } from '../../../src/modules/accounts/services/balance-adjustment'

describe('netAdjustmentKobo', () => {
  it('subtracts money that went out', () => {
    // The fix, stated plainly: a typed payment has to move the balance.
    expect(netAdjustmentKobo([{ type: 'DEBIT', amountKobo: 500_000n }])).toBe(-500_000n)
  })

  it('adds money that came in', () => {
    expect(netAdjustmentKobo([{ type: 'CREDIT', amountKobo: 500_000n }])).toBe(500_000n)
  })

  it('nets a mixed run', () => {
    const net = netAdjustmentKobo([
      { type: 'DEBIT', amountKobo: 500_000n },
      { type: 'CREDIT', amountKobo: 1_200_000n },
      { type: 'DEBIT', amountKobo: 200_000n },
    ])

    expect(net).toBe(500_000n)
  })

  it('is zero when nothing has moved', () => {
    // Which is what makes an untouched balance show the bank's figure exactly,
    // rather than the bank's figure plus a rounding artefact.
    expect(netAdjustmentKobo([])).toBe(0n)
  })

  it('stays exact past what a float could hold', () => {
    const net = netAdjustmentKobo([
      { type: 'CREDIT', amountKobo: 9_007_199_254_740_993n },
      { type: 'DEBIT', amountKobo: 1n },
    ])

    expect(net).toBe(9_007_199_254_740_992n)
  })
})
