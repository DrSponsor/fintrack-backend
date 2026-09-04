import { describe, expect, it } from 'vitest'
import {
  attributeByMask,
  revealedTail,
  MIN_REVEALED_DIGITS,
} from '../../../src/modules/capture/email/services/account-attribution'
import type { AttributableAccount } from '../../../src/modules/capture/email/services/account-attribution'

/** Invented account numbers. Nothing here is anybody's. */
const ACCESS: AttributableAccount = { id: 'access', accountLast4: '4471' }
const OPAY: AttributableAccount = { id: 'opay', accountLast4: '8802' }

describe('revealedTail', () => {
  it('reads the digits a bank leaves visible at the end', () => {
    expect(revealedTail('012******471')).toBe('471')
    expect(revealedTail('****4471')).toBe('4471')
  })

  it('keeps only the last four of an unmasked number', () => {
    // All an account stores is four digits, so a longer key cannot be used and
    // holding it would mean carrying more of someone's account number than the
    // app has any reason to.
    expect(revealedTail('0123454471')).toBe('4471')
  })

  it('refuses a tail too short to tell accounts apart', () => {
    expect(revealedTail('01234567**1')).toBeNull()
    expect(revealedTail('0123456**71')).toBeNull()
    expect(MIN_REVEALED_DIGITS).toBe(3)
  })

  it('refuses a mask that does not end in digits', () => {
    // The honest answer for a format this was not built against — better than
    // inventing a key out of a shape nobody has verified.
    expect(revealedTail('012******')).toBeNull()
    expect(revealedTail('')).toBeNull()
  })

  it('tolerates surrounding whitespace from a stripped table cell', () => {
    expect(revealedTail('  012******471  ')).toBe('471')
  })
})

describe('attributeByMask', () => {
  it('matches the account the bank is writing about', () => {
    const result = attributeByMask('012******471', [ACCESS, OPAY])

    expect(result.kind).toBe('matched')
    if (result.kind === 'matched') expect(result.accountId).toBe('access')
  })

  it('matches on three revealed digits against four registered ones', () => {
    // The whole reason matching is endsWith rather than equality: a bank may
    // reveal fewer digits than the user typed when registering.
    const result = attributeByMask('012******802', [ACCESS, OPAY])

    expect(result.kind).toBe('matched')
    if (result.kind === 'matched') expect(result.accountId).toBe('opay')
  })

  it('reports an alert for an account the user has not registered', () => {
    // Not an error. This is the signal the discovery flow is built on.
    const result = attributeByMask('012******999', [ACCESS, OPAY])

    expect(result.kind).toBe('unknown')
  })

  it('refuses to choose between two accounts sharing a tail', () => {
    // Three digits collide once in a thousand. Remote, not impossible — and a
    // wrong attribution is invisible the moment it is written, so a tie is
    // reported rather than broken.
    const twin: AttributableAccount = { id: 'twin', accountLast4: '9471' }
    const result = attributeByMask('012******471', [ACCESS, twin])

    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect([...result.accountIds].sort()).toEqual(['access', 'twin'])
    }
  })

  it('has no opinion when the alert stated no account number', () => {
    // Distinct from 'unknown': one says the bank named an account we do not
    // have, the other says the bank named nothing. Only the first is a
    // discovery.
    expect(attributeByMask(undefined, [ACCESS]).kind).toBe('no-opinion')
    expect(attributeByMask('   ', [ACCESS]).kind).toBe('no-opinion')
  })

  it('has no opinion when the mask reveals too little', () => {
    const result = attributeByMask('012*******1', [ACCESS])

    expect(result.kind).toBe('no-opinion')
    if (result.kind === 'no-opinion') expect(result.reason).toContain('trailing digits')
  })

  it('reports unknown rather than matching when the user has no accounts', () => {
    expect(attributeByMask('012******471', []).kind).toBe('unknown')
  })
})

describe('an account discovered from an alert', () => {
  // Every account number here is invented. Discovery stores the bank's own
  // masked number and may have no typed last-four at all, because Access
  // reveals three digits and padding to four would invent one.
  const DISCOVERED: AttributableAccount = { id: 'discovered', accountMask: '012******345' }

  it('is recognised by the mask the bank printed', () => {
    const result = attributeByMask('012******345', [DISCOVERED])

    expect(result.kind).toBe('matched')
    if (result.kind === 'matched') expect(result.accountId).toBe('discovered')
  })

  it('prefers the mask over a typed last-four that disagrees', () => {
    // The bank's own statement outranks somebody's recollection of it. If the
    // two disagree, the typed one is the one that can be wrong.
    const mixed: AttributableAccount = {
      id: 'mixed',
      accountMask: '012******345',
      accountLast4: '9999',
    }
    const result = attributeByMask('012******345', [mixed])

    expect(result.kind).toBe('matched')
  })

  it('matches a typed four-digit account against a three-digit reveal', () => {
    const typed: AttributableAccount = { id: 'typed', accountLast4: '2345' }
    expect(attributeByMask('012******345', [typed]).kind).toBe('matched')
  })

  it('matches a three-digit account against a four-digit reveal', () => {
    // The comparison runs in whichever direction has more digits, so neither
    // side has to be the longer one.
    const discovered: AttributableAccount = { id: 'short', accountMask: '012******345' }
    expect(attributeByMask('*****2345', [discovered]).kind).toBe('matched')
  })

  it('ignores an account carrying neither a mask nor enough digits', () => {
    const useless: AttributableAccount = { id: 'useless', accountLast4: '7' }
    expect(attributeByMask('012******345', [useless]).kind).toBe('unknown')
  })
})
