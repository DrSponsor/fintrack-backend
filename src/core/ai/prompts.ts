/**
 * Shared prompts for every IAIProvider implementation.
 *
 * These live outside the providers because one of them is COUPLED to logic
 * elsewhere: `parserPatternPrompt` demands an "amountValue" field, and
 * AIUniversalParser refuses any pattern it cannot round-trip against that
 * value. Drop the field from the prompt and every generated pattern is
 * silently rejected — the AI path stops working with no error anywhere.
 *
 * With one prompt per provider that hazard doubles: a fix applied to the
 * DeepSeek copy leaves the Gemini copy broken, and the failure is invisible
 * until someone switches providers. One definition, used by both.
 */

/**
 * Categorisation. `categoryNames` is the caller's allowed set.
 *
 * ── Why this prompt talks about people ───────────────────────────────────
 * The generic version — "categorize this merchant" — assumes the counterparty
 * is a business. In Nigerian retail banking it frequently is not: on a real
 * account, most counterparties are individuals ("Mary Okafor Roe",
 * "Peter Chukwu Poe"), because person-to-person transfers are how money
 * ordinarily moves.
 *
 * A model asked to categorise a person's name will invent something plausible
 * rather than admit the name carries no category. A confidently wrong category
 * is worse than "uncategorised", because the user has no reason to re-check it.
 * So the prompt names the case and tells the model exactly what to do with it.
 *
 * Direction is supplied for the same reason: it is often the deciding fact, and
 * withholding it forces a guess.
 */
export function categorizePrompt(categoryNames: readonly string[]): string {
  return `You categorize bank transactions for a Nigerian personal finance app.
Choose one category from this list: [${categoryNames.join(', ')}].

You are given the counterparty name, the amount, and the DIRECTION of the money.

Direction matters:
- DEBIT means money LEFT the user's account (spending, a transfer out, a fee).
- CREDIT means money ARRIVED (income, a refund, a transfer in).
A payment processor name on a CREDIT is usually income, not shopping.

Counterparties are often PEOPLE, not businesses, because person-to-person
transfers are ordinary here. When the counterparty is a personal name:
- Use "transfers".
- Do NOT guess a spending category from a person's name.

Return a JSON object containing:
- "category": the exact name of one category from the list.
- "confidence": a number from 0 to 1.

Report low confidence when the name genuinely does not identify a category.
"uncategorised" with low confidence is the correct answer for an ambiguous
counterparty, and is preferred over a confident guess.
`
}

/**
 * Spending narrative.
 *
 * The constraints are regulatory, not stylistic: describing spending is
 * reporting, but recommending what to do with money is financial advice, which
 * this product is not licensed to give.
 */
export const insightPrompt = `You are a personal finance tracking assistant.
Describe spending patterns factually.

RULES:
- Describe what happened. Never prescribe what to do with money.
- Never name specific investment products, savings accounts, or financial institutions.
- Never predict future market conditions.
- Frame everything as observation: "You spent ₦X on Y" not "You should...".
- End every response with: "This is a spending summary, not financial advice."
`

/**
 * Parser-pattern generation.
 *
 * "amountValue" is load-bearing, not decorative. AIUniversalParser re-runs the
 * generated regex and requires it to reproduce this exact string before the
 * pattern is trusted and cached for every user of that bank. It is what catches
 * a regex that confidently captures the closing balance, or the account number,
 * instead of the transaction amount.
 *
 * Change this prompt and pattern-safety.ts together, or not at all.
 */
export const parserPatternPrompt = `You generate regular expressions that extract fields from bank transaction emails.

Return ONLY a JSON object with these keys. Every regex has a matching Value
field stating exactly what that regex captures from THIS email:

  "amountRegex"    regex capturing the TRANSACTION amount in group 1
  "amountValue"    the exact text amountRegex captures from THIS email
  "typeRegex"      regex capturing a word indicating direction in group 1
  "typeValue"      the exact text typeRegex captures from THIS email
  "merchantRegex"  regex capturing the counterparty or description in group 1
  "merchantValue"  the exact text merchantRegex captures from THIS email
  "dateRegex"      regex capturing the transaction date in group 1
  "dateValue"      the exact text dateRegex captures from THIS email
  "balanceRegex"   regex capturing the resulting balance in group 1
  "balanceValue"   the exact text balanceRegex captures from THIS email
  "referenceRegex" regex capturing the bank's own transaction id in group 1,
                   usually labelled Reference, Reference Number, Transaction
                   Reference, Session ID or similar. OMIT BOTH REFERENCE KEYS
                   if this email does not state one.
  "referenceValue" the exact text referenceRegex captures from THIS email

Rules:
- Every regex MUST contain exactly one capturing group, and the value you want must be in group 1.
- Match on nearby literal text (labels, headings) so the pattern is specific.
- The transaction amount and the closing balance are DIFFERENT numbers. Never write a pattern that could match either.
- Never capture an account number, a reference number or a phone number as the amount.
- "typeValue" must be a word that genuinely states direction, such as Debited, Credited, Debit, Credit. A generic word like "Transaction" is not acceptable.
- "dateValue" must be the COMPLETE date as it appears, including separators. A partial capture such as "05" from "05-Mar-2026" is wrong.
- "referenceValue" must identify THIS ONE payment. It is used to tell two payments apart, so a value that would be the same on every email from this bank is worse than none. Never return a date, a label, a phone number, an account number or a support line as the reference. If you are not certain the email states a per-transaction id, omit the reference keys entirely.
- Keep each pattern under 200 characters.
- Do NOT use nested quantifiers such as (a+)+ or (.*)* — they are rejected.
- Every Value field must be copied exactly from the email text, with no reformatting.

Each regex is re-run against the email and must reproduce its stated Value. Any
field that fails is discarded, so an inaccurate Value costs you that field.
`

/** Insight user message. Kept here so both providers frame the data identically. */
export function insightUserPrompt(summary: {
  readonly periodStart: string
  readonly periodEnd: string
  readonly totalSpentKobo: string
  readonly totalIncomeKobo: string
}): string {
  return `Report Summary:
Period: ${summary.periodStart} to ${summary.periodEnd}
Total Spent (Kobo): ${summary.totalSpentKobo}
Total Income (Kobo): ${summary.totalIncomeKobo}
`
}

/**
 * Account discovery.
 *
 * ── Why this is a prompt and not eleven parsers ──────────────────────────
 * Attributing every future alert correctly is hard, which is why the parser
 * path needs verified regexes and a per-bank cache. Answering "which accounts
 * appear in this inbox?" ONCE is not hard, and it has a property the parsing
 * problem does not: a person immediately checks the answer.
 *
 * That inverts the cost of being wrong. A bad regex is cached and silently
 * mis-states every transaction from that bank forever. A bad discovery is a
 * row the user does not recognise and does not tick.
 *
 * So this asks for no regexes and no per-bank code, and works on the first
 * email from a bank nobody has written a parser for.
 *
 * The model is told to omit rather than guess, because an invented account
 * number is the one output a user cannot evaluate — they will not know
 * whether they simply do not recognise their own masked number.
 */
export const accountDiscoveryPrompt = `You read bank alert emails and list the BANK ACCOUNTS that appear in them.

You are given several emails. Return ONLY a JSON object of the form:

{"accounts":[{"bankName":"...","accountMask":"...","holderName":"..."}]}

For each DISTINCT account you find:

  "bankName"     the bank or wallet that sent the alert, as a person would say
                 it — "Access Bank", "Opay", "GTBank", "Kuda". Not a domain.
  "accountMask"  the account number EXACTLY as printed, keeping any masking
                 characters. Copy it character for character: "012******345"
                 stays "012******345", and "#######257" stays "#######257".
  "holderName"   the account holder as stated in the email, if stated.

Rules:
- One entry per distinct account. If ten emails describe the same account, return it ONCE.
- Copy values exactly as they appear. Never reformat, complete, or tidy an account number.
- If an email does not state an account number, do not invent one — omit that account entirely.
- If an email does not state a holder name, set "holderName" to null. Do not guess it from the greeting of a different email.
- A # stands for a digit that was masked before you saw it. Some banks print an account number in full, so those arrive already masked this way: "#######257". Copy such a value exactly as it appears, # characters included — it is a real account and the visible digits are what identify it.
- Only reject an account number with NO digits left at all, such as "##########". That one identifies nothing.
- Return an empty array if no bank account is identifiable.

Accuracy matters more than completeness. A person is shown this list and asked
which accounts are theirs, so an account you invent is one they cannot
recognise and cannot correct.
`
