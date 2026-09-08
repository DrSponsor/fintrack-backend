import type { PrismaClient } from '../../../../generated/prisma/client'
import type { IAIProvider } from '../../../../core/ai/ai-provider.interface'
import type { AppLogger } from '../../../../core/logger'
import type { ParsedTransaction } from './parser.interface'
import { parseAmountKobo, cleanText } from './utils'
import {
  checkPattern,
  isPlausibleAmountKobo,
  isPlausibleReference,
  redactForModel,
  runPattern,
  verifyPatternFields,
} from './pattern-safety'

export type AIUniversalParserDeps = {
  readonly prisma: PrismaClient
  readonly aiProvider: IAIProvider
  readonly logger: AppLogger
}

export class AIUniversalParser {
  private readonly prisma: PrismaClient
  private readonly aiProvider: IAIProvider
  private readonly logger: AppLogger

  public constructor(deps: AIUniversalParserDeps) {
    this.prisma = deps.prisma
    this.aiProvider = deps.aiProvider
    this.logger = deps.logger
  }

  public async parse(
    senderDomain: string,
    subject: string,
    bodyHtml: string,
    bodyText: string,
  ): Promise<{ readonly tx: ParsedTransaction | null; readonly isVerified: boolean }> {
    const text = cleanText(bodyHtml || bodyText)
    const normalizedDomain = senderDomain.toLowerCase().trim()

    // 1. Look up pattern in DB
    const patternRecord = await this.prisma.parserPattern.findUnique({
      where: { senderDomain: normalizedDomain },
    })

    // A record with no patterns in it is not a pattern.
    //
    // prisma/seed.ts inserted the eight biggest Nigerian banks with
    // `patterns: {}` and `status: 'STABLE'`, as placeholders. The row existing
    // was enough to take this branch, so `parseWithPattern` was handed an empty
    // object, returned null, and the generation path below was never reached —
    // permanently. Every alert from Access, GTBank, Zenith, UBA, First Bank,
    // Kuda, Moniepoint and Opay failed to parse, while unknown domains like
    // substack.com and corel.com got working AI-generated parsers on first
    // contact. The banks the app is FOR were the only senders it could not read.
    //
    // Treating an empty record as absent lets generation run and overwrite it,
    // which self-heals the seeded rows on the next alert from each bank.
    const storedPatterns =
      patternRecord === null ? {} : (patternRecord.patterns as Record<string, string>)
    const hasUsablePattern = Object.keys(storedPatterns).length > 0

    if (patternRecord !== null && hasUsablePattern) {
      const isVerified = patternRecord.status === 'STABLE'
      const tx = this.parseWithPattern(text, storedPatterns)

      // Reports what happened rather than that it was attempted. This said
      // "Parsed email using existing AI-generated pattern" even when `tx` was
      // null, so the logs asserted success at the exact moment of failure —
      // and the line immediately after it in the worker said the parse had
      // failed. Two contradictory statements about the same email.
      this.logger.info(
        { senderDomain: normalizedDomain, isVerified, patternId: patternRecord.id, matched: tx !== null },
        tx !== null
          ? 'Parsed email using existing AI-generated pattern'
          : 'Existing pattern did not match this email',
      )

      return { tx, isVerified }
    }

    if (patternRecord !== null) {
      this.logger.warn(
        { senderDomain: normalizedDomain, patternId: patternRecord.id, status: patternRecord.status },
        'Stored pattern is empty; regenerating as if none existed',
      )
    }

    // 2. If no pattern exists, call IAIProvider.generateParserPattern under circuit breaker
    this.logger.info(
      { senderDomain: normalizedDomain },
      'No pattern found. Requesting AI to generate new parser patterns.',
    )

    // Redacted before it leaves the process. The model needs the document's
    // shape to write a regex, not the account holder's identity — and these
    // bodies carry a full name, an account number and a running balance.
    const generatedPatterns = await this.aiProvider.generateParserPattern(redactForModel(text))

    if (Object.keys(generatedPatterns).length === 0) {
      // The provider's reason is pulled through when it can supply one. Without
      // it, "no credit", "retired model", "bad key" and "breaker open" are one
      // indistinguishable log line, and the difference between them is the
      // difference between paying $2 and rewriting the integration.
      const withReason = this.aiProvider as { getLastError?: () => string | undefined }
      const reason = withReason.getLastError?.()
      this.logger.warn(
        { senderDomain: normalizedDomain, ...(reason !== undefined ? { reason } : {}) },
        'AI provider failed to generate patterns or circuit breaker is open',
      )
      return { tx: null, isVerified: false }
    }

    // Verified BEFORE parsing, not after. A pattern that parses to something is
    // not the same as a pattern that parses to the RIGHT thing, and this row is
    // about to become the rule for every user of this bank.
    // Screened ONCE, and everything downstream uses the result. Parsing or
    // saving the raw generation would re-admit the very fields verification
    // just rejected, which is the whole point of the gate.
    const screened = this.screenPatterns(text, generatedPatterns)
    if (screened === null) {
      return { tx: null, isVerified: false }
    }

    const tx = this.parseWithPattern(text, screened)

    // If parsing succeeds (i.e. amount and merchant found), save to DB with status LEARNING
    if (tx !== null) {
      try {
        // Upsert, not create.
        //
        // `create` throws on the unique senderDomain whenever a row already
        // exists — which is exactly the case that now reaches here, since an
        // empty seeded placeholder is treated as absent above. A generated
        // pattern would have been discarded on save, every single time, and the
        // bank would have stayed unreadable forever.
        //
        // The update deliberately overwrites the seeded row's STABLE status
        // with LEARNING. STABLE on an empty pattern was a claim of the highest
        // trust in the system on no evidence at all; a freshly generated
        // pattern has earned exactly the trust of one email it could read.
        await this.prisma.parserPattern.upsert({
          where: { senderDomain: normalizedDomain },
          create: {
            senderDomain: normalizedDomain,
            bankName: this.inferBankName(senderDomain),
            status: 'LEARNING',
            patterns: screened,
            aiGenerated: true,
            confirmedByUsers: 0,
            version: 1,
            lastValidated: new Date(),
          },
          update: {
            status: 'LEARNING',
            patterns: screened,
            aiGenerated: true,
            lastValidated: new Date(),
          },
        })
        this.logger.info(
          { senderDomain: normalizedDomain },
          'Successfully generated and saved new parser pattern in LEARNING status',
        )
      } catch (err) {
        // Handle race conditions where another worker inserted the pattern concurrently
        this.logger.warn(
          { senderDomain: normalizedDomain, err },
          'Failed to save generated parser pattern (likely unique constraint conflict)',
        )
      }
    }

    return { tx, isVerified: false }
  }

  private parseWithPattern(text: string, patterns: Record<string, string>): ParsedTransaction | null {
    try {
      const amountRegexStr = patterns.amountRegex || patterns.amount_kobo
      const typeRegexStr = patterns.typeRegex || patterns.type
      const merchantRegexStr = patterns.merchantRegex || patterns.merchant_name
      const dateRegexStr = patterns.dateRegex || patterns.date
      const balanceRegexStr = patterns.balanceRegex || patterns.balance_kobo
      const referenceRegexStr = patterns.referenceRegex || patterns.reference

      if (!amountRegexStr) return null

      // Every pattern goes through checkPattern, including ones already stored:
      // a row saved before these checks existed, or edited in the database, is
      // no more trustworthy than a fresh generation.
      const amountCheck = checkPattern(amountRegexStr)
      if (!amountCheck.ok) {
        this.logger.warn({ reason: amountCheck.reason }, 'Rejected unsafe amount pattern')
        return null
      }
      const amountRaw = runPattern(amountCheck.regex, text)
      if (amountRaw === null) return null

      const amountKobo = parseAmountKobo(amountRaw)
      // A figure can extract cleanly and still be nonsense — a reference number,
      // a year. Caching a nonsense parse as the rule for an entire bank is the
      // expensive mistake, so the magnitude is checked before it can happen.
      if (!isPlausibleAmountKobo(amountKobo)) {
        this.logger.warn({ amountRaw }, 'Rejected implausible amount from pattern')
        return null
      }

      let type: 'DEBIT' | 'CREDIT' = 'DEBIT'
      if (typeRegexStr) {
        const typeCheck = checkPattern(typeRegexStr)
        if (typeCheck.ok) {
          const typeVal = runPattern(typeCheck.regex, text)?.toUpperCase() ?? ''
          // Word-boundary matched, not substring. `includes('CR')` was the same
          // bug that made the Access parser read every credit as a debit,
          // because the bank's own footer contains the word "Address".
          if (/\b(CREDIT|CR|RECEIVED|INWARD|DEPOSIT)\b/.test(typeVal)) {
            type = 'CREDIT'
          }
        }
      }

      let merchantName = 'AI Captured Transaction'
      if (merchantRegexStr) {
        const merchantCheck = checkPattern(merchantRegexStr)
        if (merchantCheck.ok) {
          merchantName = runPattern(merchantCheck.regex, text) ?? merchantName
        }
      }

      let transactionDate = new Date()
      if (dateRegexStr) {
        const dateCheck = checkPattern(dateRegexStr)
        if (dateCheck.ok) {
          const dateRaw = runPattern(dateCheck.regex, text)
          if (dateRaw !== null) {
            const parsedDate = new Date(dateRaw)
            if (!isNaN(parsedDate.getTime())) {
              transactionDate = parsedDate
            }
          }
        }
      }

      let balanceAfterKobo: bigint | undefined = undefined
      if (balanceRegexStr) {
        const balanceCheck = checkPattern(balanceRegexStr)
        if (balanceCheck.ok) {
          const balanceRaw = runPattern(balanceCheck.regex, text)
          if (balanceRaw !== null) {
            const parsed = parseAmountKobo(balanceRaw)
            // A bad balance must not discard an otherwise good transaction, so
            // this drops the field rather than failing the parse.
            if (isPlausibleAmountKobo(parsed)) balanceAfterKobo = parsed
          }
        }
      }

      // The bank's own id for this payment, where the pattern set has one. It
      // is the only field that can later settle whether two alerts describe the
      // same money by equality rather than judgement — so it is also the field
      // where a bad capture does the most damage. A pattern that latched onto
      // something CONSTANT in the template would hand every alert from this
      // bank the same "reference", and unrelated payments would begin
      // collapsing into one another.
      //
      // isPlausibleReference is the shape half of the defence, applied here so
      // a stored pattern that predates this check is screened on every use, not
      // only at generation. The other half is at ingest, where the value is
      // tested against every row already carrying it.
      let reference: string | undefined = undefined
      if (referenceRegexStr) {
        const referenceCheck = checkPattern(referenceRegexStr)
        if (referenceCheck.ok) {
          const referenceRaw = runPattern(referenceCheck.regex, text)
          if (referenceRaw !== null && isPlausibleReference(referenceRaw)) {
            reference = referenceRaw.trim()
          }
        }
      }

      return {
        amountKobo,
        type,
        merchantName,
        transactionDate,
        balanceAfterKobo,
        reference,
      }
    } catch (err) {
      this.logger.warn({ err }, 'Error parsing text with patterns')
      return null
    }
  }

  /**
   * Whether a freshly generated pattern may be saved and reused.
   *
   * The model returns each regex ALONGSIDE the value it claims that regex
   * extracts from this email. Trust requires the regex to actually reproduce
   * that value — a self-consistency check the model cannot pass by accident.
   *
   * This is what stops the dangerous silent failure: an amount regex that
   * captures the masked account number produces `012******345`, which cannot
   * round-trip against a declared amount of `1,234.56`. Without this, that
   * pattern is saved and every future email from the bank parses to a
   * confident, wrong figure.
   */
  /**
   * Verifies every field and returns only the patterns that earned their place.
   *
   * ── Why the policy differs per field ─────────────────────────────────────
   * Verifying only the amount was a defensible start but an incomplete one. The
   * right rule is not "verify everything or reject everything" — it is to weigh
   * what being WRONG costs against what being ABSENT costs:
   *
   *   AMOUNT and TYPE are required. A wrong figure corrupts the ledger, and a
   *   wrong direction turns income into spending — both silently, and both
   *   poisoning every total the user reads. Neither has a safe default, so an
   *   unverified one fails the whole pattern.
   *
   *   DATE, MERCHANT and BALANCE are dropped rather than fatal. Each has an
   *   honest fallback — the email's own timestamp, a generic label, an absent
   *   optional field — and losing a real transaction entirely is worse than
   *   recording it with a slightly weaker label.
   *
   * Unverified patterns are STRIPPED from what gets saved, so a field that
   * failed here can never be applied to a future email. parseWithPattern
   * already falls back cleanly when a regex is absent, which is why removing
   * the key is all this has to do.
   */
  private screenPatterns(
    text: string,
    patterns: Record<string, string>,
  ): Record<string, string> | null {
    const verdicts = verifyPatternFields(patterns, text, parseAmountKobo)
    const failed = verdicts.filter((v) => !v.verified)

    const fatal = failed.filter((v) => v.field === 'amount' || v.field === 'type')
    if (fatal.length > 0) {
      this.logger.warn(
        { failures: fatal.map((v) => `${v.field}: ${v.reason ?? 'unverified'}`) },
        'Generated pattern failed verification on a required field — discarding',
      )
      return null
    }

    const kept: Record<string, string> = { ...patterns }
    for (const verdict of failed) {
      for (const key of Object.keys(kept)) {
        if (key.toLowerCase().startsWith(verdict.field)) delete kept[key]
      }
    }

    if (failed.length > 0) {
      this.logger.info(
        { dropped: failed.map((v) => `${v.field}: ${v.reason ?? 'unverified'}`) },
        'Generated pattern accepted with unverified fields removed',
      )
    }

    return kept
  }

  private inferBankName(domain: string): string {
    const part = domain.split('.')[0] ?? 'Unknown'
    return part.charAt(0).toUpperCase() + part.slice(1)
  }
}
