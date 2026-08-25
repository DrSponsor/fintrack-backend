import { describe, it, expect } from 'vitest'
import {
  checkPattern,
  runPattern,
  verifyExtraction,
  isPlausibleAmountKobo,
  redactForModel,
  verifyPatternFields,
} from '../../../src/modules/capture/email/parsers/pattern-safety'
import { parseAmountKobo } from '../../../src/modules/capture/email/parsers/utils'

/**
 * The real Access Bank email, flattened the way cleanText leaves it. Used as
 * the substrate for every test here so that "safe" and "correct" are judged
 * against a document that actually exists.
 */
const REAL_EMAIL =
  'Dear JOHN ADEBAYO DOE, Your account has been Debited NGN 4,989.25 ' +
  'Transaction Summary A/C Number 012******345 Account Name JOHN ADEBAYO DOE ' +
  'Description MOBILE TRF TO PAY/ /JOHN ADEBAYO Reference Number 312ABCD2600000AA ' +
  'Transaction Branch IDIMU BRANCH Transaction Date 17-Aug-2026 Value Date 17-Aug-2026 ' +
  'Available Balance 200,000.00'

describe('checkPattern — rejecting patterns that can hang the worker', () => {
  it('rejects nested quantifiers, the classic catastrophic-backtracking shape', () => {
    const result = checkPattern('(a+)+$')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('nested quantifier')
  })

  it('rejects a repeated alternation group', () => {
    expect(checkPattern('(NGN|NG)*([0-9,.]+)').ok).toBe(false)
  })

  it('rejects an excessive repetition bound', () => {
    expect(checkPattern('(\\d{99999,})').ok).toBe(false)
  })

  it('rejects a pattern with no capture group, since every caller reads match[1]', () => {
    const result = checkPattern('NGN [0-9,]+\\.[0-9]{2}')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('capture group')
  })

  it('does not mistake a non-capturing group for a capture group', () => {
    expect(checkPattern('(?:NGN)\\s[0-9,.]+').ok).toBe(false)
  })

  it('rejects invalid regex syntax instead of throwing', () => {
    expect(checkPattern('([unclosed').ok).toBe(false)
  })

  it('accepts a sane, specific extractor', () => {
    expect(checkPattern('Debited\\s+NGN\\s+([0-9,]+\\.[0-9]{2})').ok).toBe(true)
  })
})

describe('runPattern', () => {
  it('extracts group 1 from the real email', () => {
    const check = checkPattern('been\\s+\\w+\\s+NGN\\s+([0-9,]+\\.[0-9]{2})')
    expect(check.ok).toBe(true)
    if (check.ok) expect(runPattern(check.regex, REAL_EMAIL)).toBe('4,989.25')
  })

  it('returns null rather than throwing when nothing matches', () => {
    const check = checkPattern('TOTALLY_ABSENT_([0-9]+)')
    if (check.ok) expect(runPattern(check.regex, REAL_EMAIL)).toBeNull()
  })
})

describe('verifyExtraction — the round-trip that makes a pattern trustworthy', () => {
  it('accepts a regex that reproduces the value the model declared', () => {
    const check = checkPattern('Debited\\s+NGN\\s+([0-9,]+\\.[0-9]{2})')
    expect(check.ok).toBe(true)
    if (check.ok) expect(verifyExtraction(check.regex, REAL_EMAIL, '4,989.25')).toBe(true)
  })

  it('tolerates cosmetic differences in how the model writes the value', () => {
    const check = checkPattern('Debited\\s+NGN\\s+([0-9,]+\\.[0-9]{2})')
    if (check.ok) expect(verifyExtraction(check.regex, REAL_EMAIL, 'NGN 4,989.25')).toBe(true)
  })

  it('REJECTS a regex that captures the account number instead of the amount', () => {
    // The exact silent failure this whole module exists to prevent. Left
    // unchecked, this pattern is saved and every future email from the bank
    // parses to a confident, wrong figure.
    const check = checkPattern('A/C Number\\s+([0-9*]+)')
    expect(check.ok).toBe(true)
    if (check.ok) {
      expect(runPattern(check.regex, REAL_EMAIL)).toBe('012******345')
      expect(verifyExtraction(check.regex, REAL_EMAIL, '4,989.25')).toBe(false)
    }
  })

  it('REJECTS a regex that captures the closing balance instead of the amount', () => {
    // The likelier mistake in practice: both are money, both look plausible,
    // and only the round-trip separates them.
    const check = checkPattern('Available Balance\\s+([0-9,]+\\.[0-9]{2})')
    if (check.ok) {
      expect(runPattern(check.regex, REAL_EMAIL)).toBe('200,000.00')
      expect(verifyExtraction(check.regex, REAL_EMAIL, '4,989.25')).toBe(false)
    }
  })

  it('rejects when the model omits the expected value', () => {
    const check = checkPattern('NGN\\s+([0-9,]+\\.[0-9]{2})')
    if (check.ok) expect(verifyExtraction(check.regex, REAL_EMAIL, undefined)).toBe(false)
  })
})

describe('isPlausibleAmountKobo', () => {
  it('rejects zero', () => {
    expect(isPlausibleAmountKobo(0n)).toBe(false)
  })

  it('accepts an ordinary transaction', () => {
    expect(isPlausibleAmountKobo(parseAmountKobo('4,989.25'))).toBe(true)
  })

  it('rejects a reference number misread as an amount', () => {
    // 312ABCD2600000AA stripped of letters is 3122622900 -> parsed as naira
    // this is over 31 billion, which no retail alert reports.
    expect(isPlausibleAmountKobo(parseAmountKobo('3122622900') * 100n)).toBe(false)
  })
})

describe('redactForModel', () => {
  it('masks the account number but preserves its shape', () => {
    const out = redactForModel(REAL_EMAIL)
    expect(out).not.toContain('012******345')
    expect(out).toContain('############')
  })

  it('removes the account holder name from the salutation', () => {
    const out = redactForModel(REAL_EMAIL)
    expect(out).toContain('Dear ACCOUNT HOLDER')
  })

  it('removes the name from the Account Name field too, not just the salutation', () => {
    // Regression: the first version masked only the salutation, so the name
    // still travelled to the model inside "Account Name ...". Caught by
    // printing what actually left the process.
    const out = redactForModel(REAL_EMAIL)
    expect(out).not.toContain('JOHN ADEBAYO DOE')
  })

  it('keeps the Account Name LABEL so a generated pattern still anchors on it', () => {
    expect(redactForModel(REAL_EMAIL)).toContain('Account Name')
  })

  it('KEEPS the amount, which the model must see to write a pattern for it', () => {
    expect(redactForModel(REAL_EMAIL)).toContain('4,989.25')
  })

  it('keeps the labels the pattern will anchor on', () => {
    const out = redactForModel(REAL_EMAIL)
    expect(out).toContain('Available Balance')
    expect(out).toContain('Transaction Date')
  })
})

describe('verifyPatternFields — every field, not just the amount', () => {
  // The real Access Bank debit alert, flattened as cleanText leaves it.
  const EMAIL =
    'Dear JOHN ADEBAYO DOE, Your account has been Debited NGN 4,989.25 ' +
    'Transaction Summary A/C Number 012******345 Account Name JOHN ADEBAYO DOE ' +
    'Description MOBILE TRF TO PAY/ /JOHN ADEBAYO Reference Number 312ABCD2600000AA ' +
    'Transaction Branch IDIMU BRANCH Transaction Date 17-Aug-2026 Value Date 17-Aug-2026 ' +
    'Available Balance 200,000.00'

  // String.raw throughout. These are regex SOURCES stored as strings, so a
  // plain literal silently eats the backslashes — '\d' becomes 'd', and the
  // pattern matches a literal letter d instead of a digit. The first version of
  // this fixture had exactly that defect and made a working verifier look
  // broken.
  const GOOD: Record<string, string> = {
    amountRegex: String.raw`Debited NGN ([\d,]+\.\d{2})`,
    amountValue: '4,989.25',
    typeRegex: String.raw`(Debited)`,
    typeValue: 'Debited',
    merchantRegex: String.raw`Description ([A-Z0-9/ ]+?) Reference`,
    merchantValue: 'MOBILE TRF TO PAY/ /JOHN ADEBAYO',
    dateRegex: String.raw`Transaction Date ([0-9]{2}-[A-Za-z]{3}-[0-9]{4})`,
    dateValue: '17-Aug-2026',
    balanceRegex: String.raw`Available Balance ([\d,]+\.\d{2})`,
    balanceValue: '200,000.00',
  }

  const verdict = (patterns: Record<string, string>, field: string) =>
    verifyPatternFields(patterns, EMAIL, parseAmountKobo).find((v) => v.field === field)

  it('verifies all five fields of a correct pattern set', () => {
    const verdicts = verifyPatternFields(GOOD, EMAIL, parseAmountKobo)
    expect(verdicts.every((v) => v.verified)).toBe(true)
  })

  it('rejects a date pattern that captures only part of the date', () => {
    // The exact defect the hand-written Access parser had: a character class
    // missing '/' turned 17/08/2026 into "17", which new Date() happily reads
    // as the year 2001.
    const truncated = { ...GOOD, dateRegex: 'Transaction Date ([0-9]{2})', dateValue: '17' }
    expect(verdict(truncated, 'date')?.verified).toBe(false)
  })

  it('rejects a type pattern capturing a word that states no direction', () => {
    const vague = { ...GOOD, typeRegex: '(Transaction) Summary', typeValue: 'Transaction' }
    const v = verdict(vague, 'type')
    expect(v?.verified).toBe(false)
    expect(v?.reason).toContain('no direction')
  })

  it('rejects an amount pattern that captures the balance instead', () => {
    // Round-trips against its own declared value, so only comparing the two
    // strings would pass this. It is wrong because the declared value is wrong.
    const wrong = {
      ...GOOD,
      amountRegex: String.raw`Available Balance ([\d,]+\.\d{2})`,
      amountValue: '4,989.25',
    }
    expect(verdict(wrong, 'amount')?.verified).toBe(false)
  })

  it('rejects a field whose declared value is absent', () => {
    const { dateValue: _omitted, ...noDeclared } = GOOD
    expect(verdict(noDeclared, 'date')?.verified).toBe(false)
  })
})
