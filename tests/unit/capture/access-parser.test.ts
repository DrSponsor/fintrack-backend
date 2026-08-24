/**
 * Access Bank parser, tested against real alerts.
 *
 * The fixtures below are the actual HTML Access Bank sends — a debit and a
 * credit captured from a live mailbox — not a format invented alongside the
 * parser. That distinction is the entire point of this file: the previous
 * parser had a passing unit test while failing on all 41 real alerts in the
 * same mailbox, because the test asserted the format its author imagined.
 *
 * Account numbers are already masked by the bank (012******345).
 */
import { describe, expect, it } from 'vitest'
import { AccessParser } from '../../../src/modules/capture/email/parsers/access.parser'

const parser = new AccessParser()

/** Builds the Transaction Summary table as Access actually marks it up. */
function alertHtml(opts: {
  readonly direction: 'Debited' | 'Credited'
  readonly amount: string
  readonly description: string
  readonly reference: string
  readonly transactionDate: string
  readonly balance: string
}): string {
  return `
  <html><body>
    <p>Dear JOHN ADEBAYO DOE,</p>
    <h3>Your account has been ${opts.direction}</h3>
    <h1>NGN ${opts.amount}</h1>
    <h4>Transaction Summary</h4>
    <table>
      <tr><td>A/C Number</td><td>012******345</td></tr>
      <tr><td>Account Name</td><td>JOHN ADEBAYO DOE</td></tr>
      <tr><td>Description</td><td>${opts.description}</td></tr>
      <tr><td>Reference Number</td><td>${opts.reference}</td></tr>
      <tr><td>Transaction Branch</td><td>IDIMU BRANCH</td></tr>
      <tr><td>Transaction Date</td><td>${opts.transactionDate}</td></tr>
      <tr><td>Value Date</td><td>${opts.transactionDate}</td></tr>
      <tr><td>Available Balance</td><td>${opts.balance}</td></tr>
    </table>
    <p>Access Bank Plc. Address: Victoria Island, Lagos.</p>
  </body></html>`
}

const DEBIT = alertHtml({
  direction: 'Debited',
  amount: '4,989.25',
  description: 'MOBILE TRF TO PAY/ /JOHN ADEBAYO',
  reference: '312ABCD2600000AA',
  transactionDate: '17-Aug-2026',
  balance: '200,000.00',
})

const CREDIT = alertHtml({
  direction: 'Credited',
  amount: '14,475.00',
  description: 'Paystack/PSST10vKoAt88Afi071756082',
  reference: '312NIPL2620500H4',
  transactionDate: '24-Jul-2026',
  balance: '242,327.00',
})

describe('AccessParser — real debit alert', () => {
  it('extracts every field', async () => {
    const result = await parser.parse('Access Bank Transaction Alert', DEBIT, '')
    expect(result).not.toBeNull()
    expect(result?.amountKobo).toBe(498925n)
    expect(result?.type).toBe('DEBIT')
    expect(result?.balanceAfterKobo).toBe(20000000n)
  })

  it('dates the transaction from the alert, not from now', async () => {
    // The old parser produced Invalid Date and silently substituted the sync
    // time, which stamped every backfilled transaction with today.
    const result = await parser.parse('Access Bank Transaction Alert', DEBIT, '')
    expect(result?.transactionDate.toISOString().slice(0, 10)).toBe('2026-08-17')
  })

  it('names the counterparty, not the transfer type', async () => {
    const result = await parser.parse('Access Bank Transaction Alert', DEBIT, '')
    expect(result?.merchantName).toBe('JOHN ADEBAYO')
  })
})

describe('AccessParser — real credit alert', () => {
  it('reads Credited as CREDIT despite "Address" in the footer', async () => {
    // Regression: direction used to be inferred with /credit|cr/ && !/debit|dr/.
    // "Address" contains "dr", so every credit was classified as a debit and
    // income was recorded as spending. The fixture keeps the real footer.
    const result = await parser.parse('Access Bank Transaction Alert', CREDIT, '')
    expect(result?.type).toBe('CREDIT')
  })

  it('extracts amount, balance and date', async () => {
    const result = await parser.parse('Access Bank Transaction Alert', CREDIT, '')
    expect(result?.amountKobo).toBe(1447500n)
    expect(result?.balanceAfterKobo).toBe(24232700n)
    expect(result?.transactionDate.toISOString().slice(0, 10)).toBe('2026-07-24')
  })

  it('takes the payer name, not the processor reference', async () => {
    // Inbound puts the name FIRST; outbound puts it last.
    const result = await parser.parse('Access Bank Transaction Alert', CREDIT, '')
    expect(result?.merchantName).toBe('Paystack')
  })

  it('reads "Transfer from NAME" descriptions', async () => {
    const html = alertHtml({
      direction: 'Credited',
      amount: '3,000.00',
      description: 'Transfer from YETUNDE TEMILOLA OLUYOMBO',
      reference: '312HABR2620200bk',
      transactionDate: '21-Jul-2026',
      balance: '204,923.50',
    })
    const result = await parser.parse('Access Bank Transaction Alert', html, '')
    expect(result?.merchantName).toBe('YETUNDE TEMILOLA OLUYOMBO')
    expect(result?.type).toBe('CREDIT')
  })
})

describe('AccessParser — amount versus balance', () => {
  it('takes the NGN-prefixed amount, never the bare balance', async () => {
    // Both are money on the same flattened line after tag-stripping. Only the
    // amount carries the currency prefix, and picking the wrong one would
    // record a ₦200,000 purchase instead of a ₦4,989.25 one.
    const result = await parser.parse('Access Bank Transaction Alert', DEBIT, '')
    expect(result?.amountKobo).toBe(498925n)
    expect(result?.amountKobo).not.toBe(20000000n)
  })
})

describe('AccessParser — rejects what it should', () => {
  it('returns null for mail that is not an Access alert', async () => {
    const result = await parser.parse('Your LinkedIn digest', '<p>3 jobs for you</p>', '')
    expect(result).toBeNull()
  })

  it('returns null when the direction sentence is missing', async () => {
    const result = await parser.parse('Access Bank', '<p>NGN 4,989.25 statement enclosed</p>', '')
    expect(result).toBeNull()
  })
})
