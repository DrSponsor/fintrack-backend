import type { IEmailParser, ParsedTransaction } from './parser.interface'
import { parseAmountKobo, cleanText } from './utils'

/**
 * Access Bank email alerts.
 *
 * ── Rewritten against real mail ──────────────────────────────────────────
 * The previous version parsed a format Access Bank does not send. It looked
 * for `Amt: NGN 10,500.50 Dr; Desc: POS SPAR; Date: 14-Jun-2026; Bal: ...` —
 * semicolon-delimited `Label: value` pairs. A real alert is an HTML TABLE with
 * no colons and no `Amt` label anywhere:
 *
 *     Your account has been Debited
 *     NGN 4,989.25
 *     Transaction Summary
 *     A/C Number          012******345
 *     Description         MOBILE TRF TO PAY/ /JOHN ADEBAYO
 *     Reference Number    312ABCD2600000AA
 *     Transaction Date    17-Aug-2026
 *     Available Balance   200,000.00
 *
 * Every field pattern therefore failed, and the amount pattern failed first,
 * so `parse` returned null for all 41 real alerts in the test mailbox. The unit
 * test passed throughout, because the fixture was written from the same
 * imagination as the parser.
 *
 * ── Three things the real format decides for us ──────────────────────────
 *
 *   DIRECTION IS A SENTENCE. "Your account has been Debited/Credited" is
 *   explicit, so direction no longer has to be inferred. The old code tested
 *   `/credit|cr/ && !/debit|dr/`, and the bank's own footer contains the word
 *   "Address" — which contains "dr" — so every credit was filed as a debit.
 *   Income appeared as spending. Same substring bug as the safety filter: two
 *   letters matched against a whole HTML body.
 *
 *   ONLY THE AMOUNT CARRIES "NGN". Available Balance prints bare (200,000.00),
 *   so the currency prefix is what separates the transaction amount from the
 *   balance. Both are money on the same line after tag-stripping, and nothing
 *   else distinguishes them.
 *
 *   FIELDS ARE DELIMITED BY THE NEXT LABEL. Once `cleanText` strips the table
 *   markup, a row is just "Description <value> Reference Number <value>". A
 *   value is therefore whatever sits between its own label and the next known
 *   one, which is why LABELS below must stay complete: a missing label makes
 *   the preceding field swallow it.
 */

/** Every label in the Transaction Summary table, in the order Access sends
 *  them. Used as terminators for each other — see the header note. */
const LABELS = [
  'A/C Number',
  'Account Name',
  'Description',
  'Reference Number',
  'Transaction Branch',
  'Transaction Date',
  'Value Date',
  'Available Balance',
] as const

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Reads one table cell: everything between its label and the next label. */
function field(text: string, label: string): string | null {
  const terminators = LABELS.filter((other) => other !== label)
    .map(escapeRegex)
    .join('|')
  const pattern = new RegExp(
    `${escapeRegex(label)}\\s*:?\\s*(.*?)\\s*(?=${terminators}|$)`,
    'i',
  )
  const match = pattern.exec(text)
  const value = match?.[1]?.trim()
  return value !== undefined && value.length > 0 ? value : null
}

/**
 * Parses Access Bank's `17-Aug-2026`.
 *
 * Built explicitly rather than handed to `new Date(string)`, whose behaviour on
 * non-ISO input is implementation-defined — the previous parser relied on that
 * and silently fell back to "now" whenever it produced Invalid Date, stamping
 * every historical transaction with the sync time.
 */
function parseAccessDate(value: string): Date | null {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim())
  if (!match) return null
  const [, day, monthName, year] = match
  if (day === undefined || monthName === undefined || year === undefined) return null
  const month = MONTHS[monthName.toLowerCase()]
  if (month === undefined) return null
  // UTC midnight: the alert states a calendar date with no time, and building
  // it in local time would shift the date for anyone east of the meridian.
  return new Date(Date.UTC(Number(year), month, Number(day)))
}

/**
 * Turns a Description cell into something a person recognises.
 *
 * Outbound and inbound put the counterparty at opposite ends, which is the same
 * asymmetry the SMS format has:
 *
 *   MOBILE TRF TO PAY/ /JOHN ADEBAYO   -> last segment
 *   Paystack/PSST10vKoAt88Afi071756082          -> first segment
 *   Transfer from YETUNDE TEMILOLA OLUYOMBO     -> after "from"
 */
function readMerchant(description: string): string {
  const inbound = /\b(?:transfer|trf)\s+from\s+(.+)$/i.exec(description)
  const inboundName = inbound?.[1]?.trim()
  if (inboundName !== undefined && inboundName.length > 0) return inboundName

  const segments = description
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  if (segments.length < 2) return description.trim()

  const first = segments[0] ?? ''
  const last = segments[segments.length - 1] ?? ''

  // A long unbroken alphanumeric run is a processor's own reference, which
  // means the NAME is the segment before it. "Paystack" is 8 characters and a
  // real counterparty name almost always contains a space, so the length floor
  // keeps names out.
  if (segments.length === 2 && /^[A-Za-z0-9]{10,}$/.test(last)) return first

  return last
}

export class AccessParser implements IEmailParser {
  public readonly parserId = '6ba7b810-9dad-11d1-80b4-00c04fd430c2'
  public readonly bankName = 'Access Bank'
  public readonly supportedDomains = ['accessbankplc.com'] as const

  public parse(subject: string, bodyHtml: string, bodyText: string): Promise<ParsedTransaction | null> {
    const text = cleanText(bodyHtml || bodyText)

    // Structural validation replaces the old name check, which required the
    // words "access bank" in the body — unreliable, since the branding is an
    // image. If the direction sentence and an NGN amount are both present, this
    // is an Access alert; if they are not, no amount of name-matching helps.
    const direction = /your account has been\s+(debited|credited)/i.exec(text)
    if (!direction?.[1]) return Promise.resolve(null)

    // The NGN prefix is what separates the amount from Available Balance.
    const amountMatch = /NGN\s*([0-9,]+\.[0-9]{2})/i.exec(text)
    if (!amountMatch?.[1]) return Promise.resolve(null)

    const type = direction[1].toLowerCase() === 'credited' ? 'CREDIT' : 'DEBIT'
    const description = field(text, 'Description')
    const rawDate = field(text, 'Transaction Date') ?? field(text, 'Value Date')
    const parsedDate = rawDate !== null ? parseAccessDate(rawDate) : null
    const balance = field(text, 'Available Balance')

    return Promise.resolve({
      amountKobo: parseAmountKobo(amountMatch[1]),
      type,
      merchantName: description !== null ? readMerchant(description) : 'Access Bank Transaction',
      // Falling back to "now" is a last resort and deliberately explicit: it
      // misdates a historical transaction, so it must never be silent.
      transactionDate: parsedDate ?? new Date(),
      ...(balance !== null ? { balanceAfterKobo: parseAmountKobo(balance) } : {}),
    })
  }
}
