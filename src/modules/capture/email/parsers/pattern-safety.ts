/**
 * Safety and verification for AI-generated parser patterns.
 *
 * ── The threat this addresses ────────────────────────────────────────────
 * A language model writes these regexes. They are then stored in
 * `parser_patterns`, keyed by sender domain, and reused for EVERY user of that
 * bank. So a single bad generation is not one bad parse — it is a permanent,
 * shared defect, and nobody reviews it before it goes live.
 *
 * Two failure modes matter, and they are very different:
 *
 *   THE PATTERN HANGS. Node has no regex timeout. A catastrophically
 *   backtracking pattern does not throw, it pins a CPU core indefinitely and
 *   takes the ingest worker down for every user of that bank. `checkPattern`
 *   below rejects the shapes that cause this and caps the input it runs on.
 *
 *   THE PATTERN LIES. Far more dangerous, because it is silent. Consider a
 *   generated amount regex that happens to capture the masked account number:
 *
 *       parseAmountKobo('012******345')  ->  1234500  ->  NGN 12,345.00
 *
 *   Plausible, wrong, and then cached and replayed against every future email
 *   from that bank. Corrupt financial data that looks authoritative is a worse
 *   outcome than parsing nothing at all, because nothing at all is visibly
 *   broken and invites a bug report.
 *
 * `verifyExtraction` is the answer to the second: the model must state what it
 * expects each regex to extract, and the regex must actually reproduce that
 * value before the pattern is trusted. A regex that grabs the account number
 * cannot round-trip against a declared amount of "1,234.56".
 */

/** Longest text we will ever run a generated pattern against. Bank emails are
 *  small; anything larger is either not an alert or is adversarial, and either
 *  way it is not worth the backtracking risk. */
export const MAX_TEXT_LENGTH = 20_000

/** Longest pattern we will accept. Legitimate field extractors are short. */
const MAX_PATTERN_LENGTH = 300

/**
 * Nested quantifiers — `(a+)+`, `(a*)*`, `(a+)*` and friends. This is the
 * classic catastrophic-backtracking shape: the engine has exponentially many
 * ways to split the input between the inner and outer repetition, so a
 * non-matching string takes exponential time to reject.
 */
const NESTED_QUANTIFIER = /\([^)]*[+*]\)\s*[+*{]/

/** Unbounded repetition of a group containing alternation — `(a|b)*` — which
 *  backtracks the same way once the alternatives can match the same text. */
const ALTERNATION_REPEAT = /\((?=[^)]*\|)[^)]*\)\s*[+*]/

/** A very large bounded repetition, which is bounded in theory and unbounded
 *  in practice. */
const HUGE_BOUND = /\{\s*\d{4,}\s*(,\s*\d*)?\s*\}/

export type PatternRejection = {
  readonly ok: false
  readonly reason: string
}

export type PatternAcceptance = {
  readonly ok: true
  readonly regex: RegExp
}

export type PatternCheck = PatternAcceptance | PatternRejection

/**
 * Compiles a generated pattern, rejecting anything unsafe.
 *
 * Static rejection rather than a runtime timeout, deliberately: Node cannot
 * interrupt a running regex from the same thread, so by the time a timeout
 * could fire the event loop is already blocked. The only reliable defence in
 * this process is to never start.
 */
export function checkPattern(source: string): PatternCheck {
  if (source.length === 0) {
    return { ok: false, reason: 'empty pattern' }
  }
  if (source.length > MAX_PATTERN_LENGTH) {
    return { ok: false, reason: `pattern longer than ${MAX_PATTERN_LENGTH} chars` }
  }
  if (NESTED_QUANTIFIER.test(source)) {
    return { ok: false, reason: 'nested quantifier — catastrophic backtracking risk' }
  }
  if (ALTERNATION_REPEAT.test(source)) {
    return { ok: false, reason: 'repeated alternation group — backtracking risk' }
  }
  if (HUGE_BOUND.test(source)) {
    return { ok: false, reason: 'excessive repetition bound' }
  }

  let regex: RegExp
  try {
    regex = new RegExp(source, 'i')
  } catch {
    return { ok: false, reason: 'not a valid regular expression' }
  }

  // A capture group is not optional: every caller reads match[1]. A pattern
  // without one always yields undefined and would be stored as a permanently
  // useless entry.
  if (!/\((?!\?[:=!])/.test(source)) {
    return { ok: false, reason: 'no capture group' }
  }

  return { ok: true, regex }
}

/**
 * Runs a checked pattern against text that has been capped in length.
 *
 * The cap is the second half of the backtracking defence: even a pattern that
 * passes the static checks degrades on pathological input, and bounding the
 * input bounds the damage.
 */
export function runPattern(regex: RegExp, text: string): string | null {
  const bounded = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text
  const match = bounded.match(regex)
  return match?.[1]?.trim() ?? null
}

/** Compares two extracted strings ignoring the separators that vary between a
 *  model's idea of a value and the document's — spaces, commas, currency marks. */
function looseEqual(a: string, b: string): boolean {
  const normalise = (value: string): string => value.replace(/[\s,₦]|NGN/gi, '').toLowerCase()
  return normalise(a) === normalise(b)
}

/**
 * Verifies that a regex extracts the value the model said it would.
 *
 * This is what makes a generated pattern trustworthy. The model returns both
 * the pattern and the value it believes that pattern pulls out of THIS email;
 * if running the regex does not reproduce that value, the model has
 * contradicted itself and the pattern is discarded.
 *
 * It catches the dangerous case directly: a regex that captures the account
 * number cannot round-trip against a stated amount, because the two strings do
 * not match. A regex that merely captures nothing is caught too.
 */
export function verifyExtraction(
  regex: RegExp,
  text: string,
  expected: string | undefined,
): boolean {
  if (expected === undefined || expected.length === 0) return false
  const actual = runPattern(regex, text)
  if (actual === null) return false
  return looseEqual(actual, expected)
}

/**
 * Sanity-checks an amount before it is allowed to define a pattern.
 *
 * A figure can round-trip perfectly and still be absurd — a reference number
 * that happens to look numeric, or a year. Rejecting implausible magnitudes
 * stops one nonsense parse from being cached as the rule for a whole bank.
 *
 * The floor is 1 kobo; the ceiling is 10 billion naira, comfortably above any
 * retail transaction while still excluding the 13-digit reference numbers that
 * appear throughout these emails.
 */
export function isPlausibleAmountKobo(kobo: bigint): boolean {
  return kobo > 0n && kobo <= 1_000_000_000_000n
}

/**
 * Whether a captured word actually states a direction of money.
 *
 * A `typeRegex` can round-trip perfectly and still be meaningless — capturing
 * "Transaction" reproduces the model's declared value and tells us nothing. The
 * captured token must be a word this system recognises as a direction, or the
 * pattern is not usable no matter how well it verifies.
 *
 * Word-boundary anchored, never substring: `includes('CR')` is the bug that
 * made the hand-written Access parser read every credit as a debit, because
 * the bank's own footer contains the word "Address".
 */
const CREDIT_TOKEN = /\b(CREDIT|CREDITED|CR|RECEIVED|INWARD|DEPOSIT|LODGEMENT)\b/
const DEBIT_TOKEN = /\b(DEBIT|DEBITED|DR|WITHDRAWAL|PAYMENT|PURCHASE|TRANSFER)\b/

export function readDirection(value: string): 'DEBIT' | 'CREDIT' | null {
  const upper = value.toUpperCase()
  const isCredit = CREDIT_TOKEN.test(upper)
  const isDebit = DEBIT_TOKEN.test(upper)
  // Both or neither is ambiguous, and guessing the direction of money is
  // exactly the thing not to do.
  if (isCredit === isDebit) return null
  return isCredit ? 'CREDIT' : 'DEBIT'
}

/**
 * Whether a parsed date is a believable transaction date.
 *
 * `new Date('17')` yields a valid Date object in the year 2001, so "valid" is
 * not the same as "sane". This is what stops a truncated capture — the exact
 * failure the old Access parser had, where a character class missing '/' turned
 * 05/03/2026 into 17 — from being cached as a bank's date rule.
 *
 * Ten years back covers any statement backfill worth having; one day forward
 * allows for timezone skew without admitting dates from next year.
 */
export function isPlausibleTransactionDate(date: Date, now: Date = new Date()): boolean {
  if (Number.isNaN(date.getTime())) return false
  const tenYearsAgo = new Date(now)
  tenYearsAgo.setFullYear(tenYearsAgo.getFullYear() - 10)
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  return date >= tenYearsAgo && date <= tomorrow
}

/**
 * Whether a captured string can serve as a bank's transaction identifier.
 *
 * This gate matters more than its size suggests, because a reference is used as
 * an EQUALITY test elsewhere: two records carrying the same one are treated as
 * the same money. A capture that is not actually an identifier therefore has a
 * failure mode the other fields do not — if a pattern latches onto something
 * CONSTANT in the bank's template, every transaction from that bank shares a
 * "reference", and payments start collapsing into each other.
 *
 * So the shape is checked narrowly:
 *
 *   Length and charset. Real references are compact alphanumeric runs, with at
 *   most the separators banks use. Prose fails immediately.
 *
 *   Digits. An identifier that carries no digits is almost certainly a captured
 *   word — "Description", "Transfer" — that happens to sit where the reference
 *   should be.
 *
 *   Dates are rejected explicitly. "05-Mar-2026" satisfies both rules above and
 *   is the single most likely wrong capture, since it sits in the adjacent
 *   table row. Every alert on a given day would share it.
 *
 * Shape alone cannot prove uniqueness, so this is only half the defence. The
 * other half is at ingest, where a reference already attached to a DIFFERENT
 * amount on the same account is discarded as not an identifier at all.
 */
const REFERENCE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9/_-]{4,63}$/
const AT_LEAST_ONE_DIGIT = /\d/
/** "05-Mar-2026", "2026-03-05", "05/03/2026" — the adjacent-row mis-capture. */
const DATE_SHAPE = /^\d{1,4}[-/](?:[A-Za-z]{3,}|\d{1,2})[-/]\d{1,4}$/

export function isPlausibleReference(value: string): boolean {
  const trimmed = value.trim()
  if (!REFERENCE_SHAPE.test(trimmed)) return false
  if (!AT_LEAST_ONE_DIGIT.test(trimmed)) return false
  if (DATE_SHAPE.test(trimmed)) return false
  return true
}

/** Fields a generated pattern set can describe. */
export type PatternField = 'amount' | 'type' | 'merchant' | 'date' | 'balance' | 'reference'

export type FieldVerdict = {
  readonly field: PatternField
  readonly verified: boolean
  /** Present when `verified` is false. */
  readonly reason?: string
}

/** Where the model may put each field, including the snake_case variants it
 *  sometimes emits despite the prompt. */
const FIELD_KEYS: Readonly<Record<PatternField, readonly [string, string, string, string]>> = {
  amount: ['amountRegex', 'amount_kobo', 'amountValue', 'amount_value'],
  type: ['typeRegex', 'type', 'typeValue', 'type_value'],
  merchant: ['merchantRegex', 'merchant_name', 'merchantValue', 'merchant_value'],
  date: ['dateRegex', 'date', 'dateValue', 'date_value'],
  balance: ['balanceRegex', 'balance_kobo', 'balanceValue', 'balance_value'],
  reference: ['referenceRegex', 'reference', 'referenceValue', 'reference_value'],
}

/**
 * Round-trip verifies EVERY field, not only the amount.
 *
 * Verifying the amount alone was a defensible starting point — a wrong amount
 * is unrecoverable — but it left three fields structurally checked and never
 * proven. A date pattern that captures the wrong token, or a type pattern that
 * captures a word carrying no direction, would have been cached as the rule for
 * an entire bank and quietly mis-stated every transaction from it.
 *
 * Verification happens at GENERATION time only, against the one email the model
 * saw. It cannot run on reuse: the declared values belong to that sample, and a
 * later email legitimately has a different amount and date. So this is the only
 * moment the claim can be tested, which is why it tests everything it can.
 *
 * Each field carries its own extra condition beyond the round trip, because a
 * string matching itself proves the regex is stable, not that it is meaningful:
 * the amount must be a plausible magnitude, the type must name a direction, and
 * the date must parse to a believable date.
 */
export function verifyPatternFields(
  patterns: Readonly<Record<string, string>>,
  text: string,
  parseAmount: (raw: string) => bigint,
): readonly FieldVerdict[] {
  const verdicts: FieldVerdict[] = []

  for (const field of Object.keys(FIELD_KEYS) as PatternField[]) {
    const [regexKey, regexAlt, valueKey, valueAlt] = FIELD_KEYS[field]
    const source = patterns[regexKey] ?? patterns[regexAlt]
    const declared = patterns[valueKey] ?? patterns[valueAlt]

    if (source === undefined || source.length === 0) {
      verdicts.push({ field, verified: false, reason: 'no pattern supplied' })
      continue
    }

    const check = checkPattern(source)
    if (!check.ok) {
      verdicts.push({ field, verified: false, reason: check.reason })
      continue
    }

    if (!verifyExtraction(check.regex, text, declared)) {
      verdicts.push({ field, verified: false, reason: 'did not reproduce the declared value' })
      continue
    }

    const captured = runPattern(check.regex, text) ?? ''

    if (field === 'amount' || field === 'balance') {
      if (!isPlausibleAmountKobo(parseAmount(captured))) {
        verdicts.push({ field, verified: false, reason: `implausible magnitude: ${captured}` })
        continue
      }
    }

    if (field === 'type' && readDirection(captured) === null) {
      verdicts.push({ field, verified: false, reason: `states no direction: ${captured}` })
      continue
    }

    if (field === 'date' && !isPlausibleTransactionDate(new Date(captured))) {
      verdicts.push({ field, verified: false, reason: `implausible date: ${captured}` })
      continue
    }

    if (field === 'reference' && !isPlausibleReference(captured)) {
      verdicts.push({ field, verified: false, reason: `not an identifier: ${captured}` })
      continue
    }

    verdicts.push({ field, verified: true })
  }

  return verdicts
}

/**
 * Removes personal detail before an email is sent to a third-party model.
 *
 * The model needs the SHAPE of the document to write a regex — labels, layout,
 * and the format of the figures. It does not need to know whose account it is.
 * Account numbers and long digit runs are masked while preserving their length
 * and grouping, so a pattern written against the redacted text still matches
 * the real thing.
 *
 * Amounts are deliberately NOT masked: they are the thing being extracted, and
 * a pattern generated against masked amounts would not match real ones.
 */
/** Escapes a literal for embedding in a RegExp. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function redactForModel(text: string): string {
  // Long digit runs — account numbers, phone numbers, reference numbers.
  // Amounts carry a decimal point and separators, so they survive this.
  let out = text.replace(/\b\d[\d*]{7,}\b/g, (match) => '#'.repeat(match.length))

  // ── The account holder's name ──────────────────────────────────────────
  // It appears in MORE than one place: the salutation, the "Account Name"
  // row, and again inside the description when the counterparty is the user
  // themselves (a transfer between their own accounts).
  //
  // Two earlier attempts were wrong in instructive ways. Masking only the
  // salutation left the other copies intact. Then matching "Account Name"
  // followed by up to five capitalised words consumed the NEXT table label
  // too — "Account Name <name> Description MOBILE" collapsed into the
  // redaction, destroying the "Description" anchor a generated pattern needs.
  //
  // Guessing where a value ends is the mistake. The name does not have to be
  // guessed: the salutation states it, so it can be matched as a literal
  // everywhere it occurs, whatever surrounds it.
  const salutation = /\b(?:Dear|Hi|Hello)\s+([A-Z][A-Za-z'-]*(?:\s+[A-Z][A-Za-z'-]*){0,3})/.exec(out)
  const fullName = salutation?.[1]

  if (fullName !== undefined) {
    // Parts individually, not just the whole string: the description often
    // carries a two-word subset of a three-word name, which a whole-string
    // replacement walks straight past.
    //
    // Short fragments are skipped — a two-letter initial would match inside
    // ordinary words and shred the document the model has to read.
    const parts = fullName.split(/\s+/).filter((part) => part.length >= 3)
    for (const part of parts) {
      out = out.replace(new RegExp(`\\b${escapeLiteral(part)}\\b`, 'gi'), 'REDACTED')
    }
  }

  return out
    .replace(/\b(Dear|Hi|Hello)\s+(REDACTED\s*)+/g, '$1 ACCOUNT HOLDER ')
    .slice(0, MAX_TEXT_LENGTH)
}

/**
 * Whether a captured string is plausibly a masked account number.
 *
 * Banks mask differently — `012******345`, `****4471`, `0117` — so the shape
 * cannot be pinned. What can be required is that it is SHORT, contains at
 * least two digits, and is made only of digits and masking characters. That
 * rejects the common mis-capture, which is a sentence or a name that happened
 * to sit next to the label.
 *
 * A wrong mask is not merely useless: alerts are attributed to accounts by it,
 * so a mis-captured one files another account's transactions under this one.
 */
export function isPlausibleAccountMask(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 4 || trimmed.length > 24) return false
  if (!/^[0-9*xX•·\- ]+$/.test(trimmed)) return false
  return (trimmed.match(/\d/g) ?? []).length >= 2
}

/**
 * Whether a captured string is plausibly a person's or business's name.
 *
 * Deliberately permissive about CONTENT — Nigerian names vary widely and this
 * must not become a list of what a name is allowed to look like — and strict
 * about SHAPE. It rejects the two things that actually get mis-captured: a run
 * of digits (an account number or a reference in the wrong slot), and a
 * fragment long enough to be a sentence rather than a name.
 *
 * The user confirms the account anyway, so this only has to be good enough to
 * avoid showing them nonsense.
 */
export function isPlausibleHolderName(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length < 3 || trimmed.length > 80) return false
  // Must contain letters, and must not be mostly digits.
  const letters = (trimmed.match(/[A-Za-z]/g) ?? []).length
  const digits = (trimmed.match(/\d/g) ?? []).length
  return letters >= 3 && letters > digits
}

/**
 * Redaction for ACCOUNT DISCOVERY, which needs the opposite of the above.
 *
 * `redactForModel` exists so a model can write a regex: it needs the SHAPE of
 * a document — labels, layout, the format of figures — and none of the
 * identity. So it masks account numbers and the holder's name, which is
 * exactly right for that job.
 *
 * Discovery asks a different question: "whose account is this, and which
 * one?". Run through the same redaction, every alert reduces to
 * `A/C Number ############ / Account Name REDACTED REDACTED`, and the answer
 * has been destroyed before the model sees it.
 *
 * ── What this keeps, and why that is defensible ──────────────────────────
 *
 *   ALREADY-MASKED ACCOUNT NUMBERS are kept. `012******345` was masked by the
 *   BANK, which decided how much of it a person may see. Masking it again
 *   protects nothing and removes the only thing that distinguishes one
 *   account from another.
 *
 *   THE HOLDER NAME is kept, because it is the field that lets a person
 *   recognise their own account in a list. This is a real disclosure and
 *   worth stating plainly — though note the app ALREADY sends counterparty
 *   names to the same provider on every uncategorised merchant, and those are
 *   third parties. A user's own name, once, is the smaller exposure.
 *
 * ── What this still removes ──────────────────────────────────────────────
 * Unmasked long digit runs: full account numbers, phone numbers, BVNs, card
 * numbers. A bank that prints the whole account number does not get to leak
 * it just because discovery is running.
 */
export function redactForDiscovery(text: string): string {
  return (
    text
      // Long digit runs, but ONLY where the bank has not already masked them.
      // The negative lookahead lets `012******345` through while still
      // catching a bare `0123456789`.
      .replace(/\b\d{7,}\b/g, (match) => '#'.repeat(match.length))
      .slice(0, MAX_TEXT_LENGTH)
  )
}
