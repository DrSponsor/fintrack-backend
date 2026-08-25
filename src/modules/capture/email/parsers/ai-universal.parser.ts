import type { PrismaClient } from '../../../../generated/prisma/client'
import type { IAIProvider } from '../../../../core/ai/ai-provider.interface'
import type { AppLogger } from '../../../../core/logger'
import type { ParsedTransaction } from './parser.interface'
import { parseAmountKobo, cleanText } from './utils'
import {
  checkPattern,
  isPlausibleAmountKobo,
  redactForModel,
  runPattern,
  verifyExtraction,
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

    if (patternRecord !== null) {
      const isVerified = patternRecord.status === 'STABLE'
      const patterns = patternRecord.patterns as Record<string, string>
      const tx = this.parseWithPattern(text, patterns)
      
      this.logger.info(
        { senderDomain: normalizedDomain, isVerified, patternId: patternRecord.id },
        'Parsed email using existing AI-generated pattern',
      )
      
      return { tx, isVerified }
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
    if (!this.isPatternTrustworthy(text, generatedPatterns)) {
      return { tx: null, isVerified: false }
    }

    const tx = this.parseWithPattern(text, generatedPatterns)

    // If parsing succeeds (i.e. amount and merchant found), save to DB with status LEARNING
    if (tx !== null) {
      try {
        await this.prisma.parserPattern.create({
          data: {
            senderDomain: normalizedDomain,
            bankName: this.inferBankName(senderDomain),
            status: 'LEARNING',
            patterns: generatedPatterns,
            aiGenerated: true,
            confirmedByUsers: 0,
            version: 1,
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

      return {
        amountKobo,
        type,
        merchantName,
        transactionDate,
        balanceAfterKobo,
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
   * round-trip against a declared amount of `4,989.25`. Without this, that
   * pattern is saved and every future email from the bank parses to a
   * confident, wrong figure.
   */
  private isPatternTrustworthy(text: string, patterns: Record<string, string>): boolean {
    const amountRegexStr = patterns.amountRegex || patterns.amount_kobo
    if (!amountRegexStr) return false

    const amountCheck = checkPattern(amountRegexStr)
    if (!amountCheck.ok) {
      this.logger.warn({ reason: amountCheck.reason }, 'Generated amount pattern rejected as unsafe')
      return false
    }

    // The amount is the only field required to round-trip. The others are
    // useful but not load-bearing: a wrong merchant name is a cosmetic defect,
    // a wrong amount is corrupt data.
    const expected = patterns.amountValue || patterns.amount_value
    if (!verifyExtraction(amountCheck.regex, text, expected)) {
      this.logger.warn(
        { expected, actual: runPattern(amountCheck.regex, text) },
        'Generated pattern failed round-trip verification — discarding',
      )
      return false
    }

    return true
  }

  private inferBankName(domain: string): string {
    const part = domain.split('.')[0] ?? 'Unknown'
    return part.charAt(0).toUpperCase() + part.slice(1)
  }
}
