import { describe, expect, it } from 'vitest'
import {
  ReconciliationService,
  merchantSimilarity,
  TIGHT_WINDOW_MS,
  WIDE_WINDOW_MS,
} from '../../../src/modules/transactions/services/reconciliation.service'
import type {
  ReconcileCandidate,
  ReconcileSubject,
} from '../../../src/modules/transactions/services/reconciliation.service'

const BASE = new Date('2026-08-20T14:30:00.000Z')
const MINUTES = 60 * 1000

function at(offsetMs: number): Date {
  return new Date(BASE.getTime() + offsetMs)
}

function incoming(overrides: Partial<ReconcileSubject> = {}): ReconcileSubject {
  return {
    merchantName: 'Shoprite',
    transactionDate: BASE,
    source: 'MANUAL',
    ...overrides,
  }
}

function candidate(overrides: Partial<ReconcileCandidate> = {}): ReconcileCandidate {
  return {
    id: 'existing-1',
    merchantName: 'Shoprite',
    transactionDate: BASE,
    source: 'MANUAL',
    ...overrides,
  }
}

const service = new ReconciliationService()

describe('merchantSimilarity', () => {
  it('sees through the extra words a bank appends', () => {
    // The realistic difference is not typos but extra words: the bank writes the
    // branch, the city and the terminal into the field the user filled with one
    // word. Scoring against the shorter side is what stops that reading as a
    // different shop.
    expect(merchantSimilarity('Shoprite', 'SHOPRITE IKEJA CITY MALL LAG')).toBe(1)
  })

  it('ignores case and punctuation', () => {
    expect(merchantSimilarity('Ikeja Electric', 'IKEJA-ELECTRIC')).toBe(1)
  })

  it('matches a run-together form against a spaced one', () => {
    expect(merchantSimilarity('QUICKTELLER/DSTV', 'DStv')).toBeGreaterThan(0.5)
  })

  it('does not match two unrelated merchants', () => {
    expect(merchantSimilarity('Shoprite', 'Ikeja Electric')).toBe(0)
  })

  it('scores an empty name as no evidence rather than a match', () => {
    expect(merchantSimilarity('', 'Shoprite')).toBe(0)
    expect(merchantSimilarity('--', 'Shoprite')).toBe(0)
  })
})

describe('ReconciliationService', () => {
  it('treats nothing as a match outside the window', () => {
    const verdict = service.reconcile(
      incoming(),
      [candidate({ transactionDate: at(WIDE_WINDOW_MS + MINUTES) })],
    )
    expect(verdict.kind).toBe('distinct')
  })

  it('treats an empty ledger as nothing to collide with', () => {
    expect(service.reconcile(incoming(), []).kind).toBe('distinct')
  })

  describe('a bank alert arriving after the user typed it in', () => {
    it('supersedes the placeholder', () => {
      const verdict = service.reconcile(
        incoming({ source: 'EMAIL', merchantName: 'Shoprite Ikeja City Mall' }),
        [candidate({ source: 'MANUAL', transactionDate: at(-40 * MINUTES) })],
      )
      expect(verdict.kind).toBe('supersedes')
    })

    it('supersedes even when the names look nothing alike', () => {
      // Someone types "Fuel"; the bank writes the station's registered trading
      // name. Demanding the names agree would leave the placeholder standing
      // beside its own bank record — the exact duplicate this prevents.
      const verdict = service.reconcile(
        incoming({ source: 'EMAIL', merchantName: 'NNPC Mega Station Wuse' }),
        [candidate({ source: 'MANUAL', merchantName: 'Fuel', transactionDate: at(-3 * 60 * MINUTES) })],
      )
      expect(verdict.kind).toBe('supersedes')
    })

    it('pairs with the closest placeholder in time, not whichever row came back first', () => {
      const verdict = service.reconcile(
        incoming({ source: 'EMAIL' }),
        [
          candidate({ id: 'far', transactionDate: at(-20 * 60 * MINUTES) }),
          candidate({ id: 'near', transactionDate: at(-6 * MINUTES) }),
        ],
      )
      expect(verdict.kind).toBe('supersedes')
      if (verdict.kind === 'supersedes') expect(verdict.candidate.id).toBe('near')
    })

    it('leaves an already-superseded row alone, so a second real payment gets its own record', () => {
      // This is what keeps recurring payments safe. Superseding flips a row's
      // source away from MANUAL, so it stops being a placeholder. Someone who
      // buys ₦500 of airtime twice in a day, having typed one of them in, must
      // still end up with two rows.
      const verdict = service.reconcile(
        incoming({ source: 'EMAIL', transactionDate: at(9 * 60 * MINUTES) }),
        [candidate({ source: 'EMAIL', transactionDate: BASE })],
      )
      expect(verdict.kind).not.toBe('supersedes')
      expect(verdict.kind).not.toBe('already-recorded')
    })
  })

  describe('a user typing in something already recorded', () => {
    it('reports it as already captured from the bank', () => {
      const verdict = service.reconcile(
        incoming({ merchantName: 'Shoprite' }),
        [candidate({ source: 'EMAIL', merchantName: 'SHOPRITE IKEJA CITY MALL', transactionDate: at(-90 * MINUTES) })],
      )
      expect(verdict.kind).toBe('already-recorded')
      if (verdict.kind === 'already-recorded') expect(verdict.reason).toContain('bank alert')
    })

    it('catches the same form filled in twice', () => {
      // Idempotency covers a double-tap on one request. It cannot cover a user
      // opening the form again and retyping the same payment.
      const verdict = service.reconcile(
        incoming(),
        [candidate({ source: 'MANUAL', transactionDate: at(-2 * MINUTES) })],
      )
      expect(verdict.kind).toBe('already-recorded')
    })

    it('asks rather than assumes when the merchant disagrees', () => {
      const verdict = service.reconcile(
        incoming({ merchantName: 'Shoprite' }),
        [candidate({ source: 'EMAIL', merchantName: 'Ikeja Electric', transactionDate: at(-8 * 60 * MINUTES) })],
      )
      expect(verdict.kind).toBe('uncertain')
    })

    it('still matches a disagreeing merchant inside the tight window', () => {
      // A card payment often surfaces under the processor's name rather than the
      // shop's, so within minutes the names carry no information and the exact
      // amount, account and direction do.
      const verdict = service.reconcile(
        incoming({ merchantName: 'Shoprite' }),
        [candidate({ source: 'EMAIL', merchantName: 'Interswitch Ltd', transactionDate: at(TIGHT_WINDOW_MS - MINUTES) })],
      )
      expect(verdict.kind).toBe('already-recorded')
    })
  })

  describe('two bank records', () => {
    it('suppresses the same alert delivered twice', () => {
      const verdict = service.reconcile(
        incoming({ source: 'EMAIL' }),
        [candidate({ source: 'EMAIL', transactionDate: at(30 * 1000) })],
      )
      expect(verdict.kind).toBe('already-recorded')
    })

    it('keeps two identical payments hours apart as separate money', () => {
      // The bug the old hash had: it ignored the merchant entirely, so ₦500 of
      // airtime bought twice in one day collapsed into one row and a real
      // payment silently disappeared.
      const verdict = service.reconcile(
        incoming({ source: 'EMAIL', merchantName: 'Airtel' }),
        [candidate({ source: 'EMAIL', merchantName: 'Airtel', transactionDate: at(-9 * 60 * MINUTES) })],
      )
      expect(verdict.kind).toBe('uncertain')
    })

    it('files two unrelated payments of the same amount separately', () => {
      const verdict = service.reconcile(
        incoming({ source: 'EMAIL', merchantName: 'Shoprite' }),
        [candidate({ source: 'EMAIL', merchantName: 'Ikeja Electric', transactionDate: at(-20 * 60 * MINUTES) })],
      )
      expect(verdict.kind).toBe('distinct')
    })
  })

  it('prefers a definite answer over a question', () => {
    // One candidate is clearly the same money and another is merely suspicious.
    // Raising the question anyway would ask the user about a call the system
    // has already made correctly.
    const verdict = service.reconcile(
      incoming(),
      [
        candidate({ id: 'suspicious', merchantName: 'Ikeja Electric', transactionDate: at(-10 * 60 * MINUTES) }),
        candidate({ id: 'definite', merchantName: 'Shoprite', transactionDate: at(-3 * MINUTES) }),
      ],
    )
    expect(verdict.kind).toBe('already-recorded')
    if (verdict.kind === 'already-recorded') expect(verdict.candidate.id).toBe('definite')
  })

  it('publishes the window callers must query with', () => {
    // The service and its callers have to agree on the span, or candidates that
    // would have matched are never fetched in the first place.
    expect(ReconciliationService.windowMs).toBe(WIDE_WINDOW_MS)
  })
})

describe('the bank reference', () => {
  // The one signal here that is not a judgement call. Amount, time and
  // counterparty can all coincide between two separate payments; a bank's own
  // transaction id cannot.

  it('separates two payments the fuzzy rules would have questioned', () => {
    // ₦500 of airtime twice in one day: same merchant, same amount, same
    // account. Without references this is 'uncertain' and both rows are kept on
    // suspicion. With them it is simply two payments, decided.
    const verdict = service.reconcile(
      incoming({ source: 'EMAIL', merchantName: 'Airtel', reference: 'REF00000002' }),
      [
        candidate({
          source: 'EMAIL',
          merchantName: 'Airtel',
          reference: 'REF00000001',
          transactionDate: at(-9 * 60 * MINUTES),
        }),
      ],
    )
    expect(verdict.kind).toBe('distinct')
  })

  it('separates them even when everything else says the same event', () => {
    // Inside the tight window, with an agreeing merchant, this would otherwise
    // be suppressed as one alert delivered twice.
    const verdict = service.reconcile(
      incoming({ source: 'EMAIL', reference: 'REF00000002' }),
      [candidate({ source: 'EMAIL', reference: 'REF00000001', transactionDate: at(30 * 1000) })],
    )
    expect(verdict.kind).toBe('distinct')
  })

  it('leaves the decision alone when only one side has a reference', () => {
    // A manual entry never carries one, and half a comparison is no evidence.
    // The fuzzy rules must still reach their own answer.
    const verdict = service.reconcile(
      incoming({ source: 'EMAIL', reference: 'REF00000002' }),
      [candidate({ source: 'MANUAL', reference: undefined })],
    )
    expect(verdict.kind).toBe('supersedes')
  })

  it('does not let a matching reference override the ordinary rules', () => {
    // Equality is deliberately NOT decided here. Trusting it would mean
    // suppressing a real payment on the strength of a value this class cannot
    // verify is unique, so that call is made at ingest, where the reference can
    // be checked against every row already carrying it.
    const verdict = service.reconcile(
      incoming({ source: 'EMAIL', merchantName: 'Airtel', reference: 'REF00000001' }),
      [
        candidate({
          source: 'EMAIL',
          merchantName: 'Airtel',
          reference: 'REF00000001',
          transactionDate: at(30 * 1000),
        }),
      ],
    )
    expect(verdict.kind).toBe('already-recorded')
  })
})
