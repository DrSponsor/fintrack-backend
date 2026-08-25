/**
 * Synthetic bank-alert fixtures.
 *
 * ── Why these are fictional ──────────────────────────────────────────────
 * The originals were real. They carried a live account holder's name, their
 * account number, genuine amounts, real bank reference numbers, and — worst —
 * the full names of the THIRD PARTIES on the other side of each transfer.
 *
 * Those people never agreed to appear in a repository, and unlike the account
 * holder they have no way to ask for removal. A repository is read by future
 * maintainers, contractors and anyone the code is ever shared with; real
 * financial data does not belong in one.
 *
 * Nothing is lost by making them fictional: parsing correctness depends
 * entirely on the STRUCTURE of these documents — the labels, their order, the
 * date format, the fact that the HTML table separates label from value with
 * whitespace rather than a colon — and never on the values themselves.
 *
 * Names follow the legal placeholder convention (Doe, Roe, Poe) so they cannot
 * be mistaken for real people, while keeping the multi-word uppercase shape
 * that Nigerian bank alerts actually use.
 *
 * ── Keep these in one place ──────────────────────────────────────────────
 * Tests and dev scripts both import from here. Copying a sample into a test
 * file is how the real data spread across eight files in two repositories in
 * the first place.
 */

/** The account holder these fixtures belong to. Fictional. */
export const HOLDER = 'JOHN ADEBAYO DOE'

/** Masked account number, in the bank's real masking shape. Fictional. */
export const ACCOUNT_MASK = '012******345'

/**
 * A debit alert, flattened exactly as cleanText leaves the real HTML email:
 * labels and values separated by spaces, no colons anywhere.
 */
export const DEBIT_ALERT =
  `Dear ${HOLDER}, Your account has been Debited NGN 1,234.56 ` +
  `Transaction Summary A/C Number ${ACCOUNT_MASK} Account Name ${HOLDER} ` +
  'Description MOBILE TRF TO PAY/ /MARY OKAFOR ROE Reference Number 312ABCD2600000AA ' +
  'Transaction Branch SAMPLE BRANCH Transaction Date 05-Mar-2026 Value Date 05-Mar-2026 ' +
  'Available Balance 50,000.00'

export const DEBIT_EXPECTED = {
  amountKobo: 123_456n,
  balanceKobo: 5_000_000n,
  amountText: '1,234.56',
  balanceText: '50,000.00',
  dateText: '05-Mar-2026',
  typeText: 'Debited',
  merchantText: 'MOBILE TRF TO PAY/ /MARY OKAFOR ROE',
} as const

/**
 * A credit alert.
 *
 * Deliberately a DIFFERENT narrative shape from the debit: inbound payments
 * from a processor arrive as `Source/reference` with no transfer keyword
 * anywhere, which is the form that silently produced "unknown" before real
 * credit samples existed.
 */
export const CREDIT_ALERT =
  `Dear ${HOLDER}, Your account has been Credited NGN 7,890.00 ` +
  `Transaction Summary A/C Number ${ACCOUNT_MASK} Account Name ${HOLDER} ` +
  'Description Paystack/PSST00SAMPLE0000000000 Reference Number 312WXYZ2600000BB ' +
  'Transaction Branch SAMPLE BRANCH Transaction Date 12-Feb-2026 Value Date 12-Feb-2026 ' +
  'Available Balance 57,890.00'

export const CREDIT_EXPECTED = {
  amountKobo: 789_000n,
  balanceKobo: 5_789_000n,
  amountText: '7,890.00',
  balanceText: '57,890.00',
  dateText: '12-Feb-2026',
  typeText: 'Credited',
  merchantText: 'Paystack/PSST00SAMPLE0000000000',
} as const

/**
 * Counterparties for exercising categorisation.
 *
 * The shapes matter, not the names: a payment processor, several individuals
 * (the dominant case in Nigerian retail banking, where person-to-person
 * transfers are ordinary), a real merchant buried in payment-rail noise, a bank
 * charge, and a POS payment at a person-named merchant that is genuinely
 * ambiguous.
 */
export const COUNTERPARTIES = {
  processor: 'Paystack',
  individualA: 'Mary Okafor Roe',
  individualB: 'Peter Chukwu Poe',
  individualC: 'Grace Amina Coe',
  merchantInNoise: 'Web Pymt Spotify 234000000000 00ng',
  bankCharge: 'Prime Visa Classic: Issuance Fee',
  posPersonNamed: 'Pos Pymt Samuel Bello Loe Lagos L',
} as const
