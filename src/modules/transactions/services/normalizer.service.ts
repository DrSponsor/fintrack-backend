/**
 * Short words that are NOT acronyms, and so should be title-cased like any
 * other word when a name arrives entirely in uppercase.
 *
 * Legal suffixes and joining words. Deliberately does not contain the things
 * that genuinely are acronyms in this market — GTB, UBA, MTN, POS, ATM, USSD —
 * which is the whole reason the short-token rule exists.
 */
const SHORT_WORDS = new Set([
  'LTD', 'PLC', 'INC', 'LLC', 'CO',
  'AND', 'THE', 'FOR', 'VIA', 'OF', 'TO', 'AT', 'ON', 'IN', 'BY',
])

export class NormalizerService {
  /**
   * Makes a merchant name readable without destroying what it already said.
   *
   * ── Why this is not just toLowerCase().titleCase() ───────────────────────
   * It used to be, and it turned MTN into "Mtn" and DSTV into "Dstv" on every
   * row. Lowercasing first throws away capitalisation that was carrying
   * meaning, and no title-casing rule can put an acronym back afterwards
   * because by then there is nothing left to distinguish MTN from mtn.
   *
   * Three cases have to be told apart, and the input tells us which is which:
   *
   *   IT MIXES CASES. Then a human or a well-formed source chose that casing —
   *   "MTN Airtime", "DSTV Subscription", "iTunes", "Opay/Shoprite" — and the
   *   right thing to do is leave it alone. Re-casing it can only lose.
   *
   *   Mixed, specifically: merely CONTAINING a lowercase letter is not enough,
   *   because "netflix" contains only lowercase ones and is not a deliberate
   *   choice — it is just an uncapitalised word, and it should come out as
   *   "Netflix".
   *
   *   IT IS ENTIRELY UPPERCASE. That is a bank alert shouting, not a name:
   *   "MOBILE TRF TO PAY/ /JANE DOE". Title-casing genuinely helps here, so
   *   it applies — except to tokens of three letters or fewer, which in an
   *   all-caps string are nearly always acronyms: GTB, UBA, MTN, POS, ATM.
   *
   *   Three, not four, and the difference is not arbitrary. At four the rule
   *   starts keeping ordinary words: "SHOPRITE IKEJA CITY MALL" came back as
   *   "Shoprite Ikeja CITY MALL", because CITY and MALL are four letters and
   *   nothing in an all-caps string distinguishes them from DSTV. Once every
   *   letter is uppercase that information is genuinely gone, so the cutoff is
   *   chosen to fail on the rarer case — a four-letter acronym in a shouting
   *   alert — rather than on common English words. DSTV typed in mixed case
   *   is untouched anyway, by the rule above.
   *
   *   IT IS ENTIRELY LOWERCASE. Just capitalise it. There are no acronyms to
   *   protect — anything that was one has already lost its capitals.
   *
   * Casing is presentation only. `getMerchantFingerprint` lowercases before
   * hashing, so nothing here changes how two names match, and existing rows
   * keep their fingerprints.
   */
  public normalizeMerchantName(rawName: string): string {
    const cleaned = rawName.replace(/\s+/g, ' ').trim()
    if (cleaned.length === 0) {
      return 'Unknown Merchant'
    }

    const hasLower = /[a-z]/.test(cleaned)
    const hasUpper = /[A-Z]/.test(cleaned)

    // Both present means somebody chose this casing. Keep it.
    if (hasLower && hasUpper) return cleaned

    // Acronyms can only be recognised in a string that still has its capitals.
    const shouting = hasUpper && !hasLower

    return cleaned
      .split(' ')
      .map((word) => {
        const letters = word.replace(/[^A-Za-z]/g, '')
        // Short all-caps runs are acronyms, not words that need fixing —
        // unless they are one of the ordinary short words below, which are
        // short for the same reason but are read as words. "OPAY NIGERIA LTD"
        // should not keep LTD shouting when nothing else on the line does.
        if (shouting && letters.length > 0 && letters.length <= 3 && !SHORT_WORDS.has(letters)) {
          return word
        }
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      })
      .join(' ')
  }

  /**
   * Generates a unique, lowercase alphanumeric fingerprint from a normalized merchant name.
   */
  public getMerchantFingerprint(normalizedName: string): string {
    return normalizedName.toLowerCase().replace(/[^a-z0-9]/g, '')
  }
}
